export const ssr = false;

import { fail } from '@sveltejs/kit'
import * as fs from 'fs/promises'
import { existsSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs"
import sharp from "sharp"
import AdmZip from "adm-zip"
import {tmpdir, type} from 'os'
import path from 'path'
import db from '$lib/server/prismadb.js'
import type { InfoHotspots, LinkHotspots, Scene } from '@prisma/client'
import { v4 } from 'uuid';
import { createCanvas, loadImage, ImageData } from "canvas";
import { equirectangularToFisheye, renderFacePromise } from '$lib/admin/convertServer.js';

const facePositions = {
  pz: {x: 1, y: 1, name: 'b'},
  nz: {x: 3, y: 1, name: 'f'},
  px: {x: 2, y: 1, name: 'l'},
  nx: {x: 0, y: 1, name: 'r'},
  py: {x: 1, y: 0, name: 'u'},
  ny: {x: 1, y: 2, name: 'd'}
}

export type LevelsType = {
  tileSize: number,
  size: number,
  fallbackOnly?: boolean
}[]

export type InitialViewParametersType = {
  pitch: number,
  yaw: number,
  zoom: number
}

export type SceneDataType =  (Omit<Scene, 'levels' | 'initialViewParameters'> & {
  levels: LevelsType;
  initialViewParameters: InitialViewParametersType;
  infoHotspots: InfoHotspots[];
  linkHotspots: LinkHotspots[];
})

export const load = async ({url}) => {
  const [scenes, groups] = await Promise.all([
    db.scene.findMany({
      include: {
        infoHotspots: true,
        linkHotspots: true
      },
      orderBy: {
        sort: 'asc'
      }
    }),
    db.groupScene.findMany()
  ])

  let scenesData: SceneDataType[] = scenes.map(v => {
    return {
      ...v,
      levels: JSON.parse(v.levels) as LevelsType,
      initialViewParameters: JSON.parse(v.initialViewParameters) as InitialViewParametersType,
    }
  })

  return { scenes: scenesData, groups }
}

export const actions = {
  addScene: async ({ cookies, request, url }) => {
    try {
      const data = await request.formData()
      let name = data.get('name') as string,
        slug = data.get('slug') as string,
        sort = data.get('sort') as string,
        image = data.get('image') as File,
        audio = data.get('audio') as File,
        groupId = data.get('groupId') as string,
        description = data.get('description') as string

      const sceneBySlug = await db.scene.findMany({
        where: {
          slug
        }
      })

      if (sceneBySlug.length > 0) {
        throw { errorText: "Slug đã tồn tại"}
      }

      const imageSharp = sharp(await image.arrayBuffer(), { limitInputPixels: false })
      
      let { width: w = 0, height: h = 0} = await imageSharp.metadata()

      // if (w / h != 2) {
      //   throw { errorText: "Ảnh equirectangular phải có tỷ lệ 2:1"}
      // }

      // if (h % 8 > 0) {
      //   imageSharp.resize({height: h - (h % 8)})
      //   h = h - (h % 8)
      //   w = h * 2
      // }

      imageSharp.resize({ width: 8192, height: 4096, fit: 'fill' })
      h = 4096
      w = 8192

      let uuid = v4()

      if (!existsSync(`./storage/tiles/${uuid}`)) {
        mkdirSync(`./storage/tiles/${uuid}`, { recursive: true })
      }

      let distance = h / 8

      for (let i = 0; i < 8; i ++) {
        for (let j = 0; j < 16; j++) {
          await imageSharp.clone().extract({left: j * distance, top: i * distance, width: distance, height: distance })
          .jpeg({ quality: 80, force: true, mozjpeg: true })
          .toFile(`./storage/tiles/${uuid}/${i}_${j}.jpg`)
          .then((data: any) => {
            return data
          })
        }
      }
    
      // save image low
      await imageSharp.clone().resize({ width: 2000 }).jpeg({ quality: 60, force: true, mozjpeg: true }).toFile(`./storage/tiles/${uuid}/low.jpg`)
        .then((data: any) => {
          return data
        })

      // create face front image
      await imageSharp.clone().raw().ensureAlpha().toBuffer()
        .then(async (img) => {
          let imageData = new Uint8ClampedArray(img)
          const dataImage = new ImageData(imageData, w, h)

          const f = await renderFacePromise({
            data: dataImage, 
            face: 'nz',
            rotation: Math.PI,
            interpolation: "linear"
          })

          return await sharp(f).resize({width: 1024}).jpeg({ quality: 60, force: true, mozjpeg: true })
            .toFile(`./storage/tiles/${uuid}/front.jpg`)
            .then((data: any) => {
              return data
            })
        })

      // create fisheye image
      await new Promise(res => res(equirectangularToFisheye(imageSharp.clone(), 512, `./storage/tiles/${uuid}/fisheye.png`)))

      // save audio file
      let audioUrl = null
      if (audio && audio.size > 0) {
        let typeAduio = path.extname(audio.name)
        await fs.writeFile(`./storage/tiles/${uuid}/audio.${typeAduio}`, audio.stream() as any)
        audioUrl = `./storage/tiles/${uuid}/audio.${typeAduio}`
      }

      const scene = await db.scene.create({
        data: {
          id: uuid,
          name: name,
          slug: slug,
          faceSize: w,
          initialViewParameters: `{
            "pitch": 0,
            "yaw": 0,
            "zoom": 50
          }`,
          url: `/storage/tiles/${uuid}`,
          levels: `[]`,
          description: description,
          audio: audioUrl,
          groupId: groupId != "null" ? groupId : null,
          sort: +sort
        }
      })

      return { success: true, scene }
    }
    catch(e: any) {
      console.log({e})
      return fail(400, { error: e.errorText || `Đã có lỗi xảy ra vui lòng thử lại sau` })
    }
  },

  deleteScene: async ({ cookies, request, url }) => {
    try {
      const data = await request.formData()
      
      let id = data.get('id') as string

      const deleteInfoHotspots = db.infoHotspots.deleteMany({
        where: {
          sceneId: id
        }
      })

      const deleteLinkHotspots = db.linkHotspots.deleteMany({
        where: {
          sceneId: id
        }
      })

      const deletescene = db.scene.delete({
        where: {
          id: id
        }
      })

      const transaction = await db.$transaction([deleteInfoHotspots, deleteLinkHotspots, deletescene])

      // await rmSync(`./storage/tiles/${id}`, { recursive: true })
      await fs.rm(`./storage/tiles/${id}`, { recursive: true })

      return { success: true }
    } 
    catch (error) {
      console.log({error})
      return fail(400, { error: `Đã có lỗi xảy ra vui lòng thử lại sau` })
    }
  },

  updateScene: async ({ cookies, request, url }) => {
    try {
      const data = await request.formData()
      let name = data.get('name') as string,
        slug = data.get('slug') as string,
        audio = data.get('audio') as File,
        oldAduio = data.get('oldAduio') as string,
        id = data.get('id') as string,
        groupId = data.get('groupId') as string,
        description = data.get('description') as string

      // save audio file
      let audioUrl = null
      if (audio && audio.size > 0) {
        let typeAduio = path.extname(audio.name)
        await fs.writeFile(`./storage/tiles/${id}/audio.${typeAduio}`, audio.stream() as any)
        audioUrl = `./storage/tiles/${id}/audio.${typeAduio}`
      }
      
      let dataUpdate: any = {
        name: name,
        description: description,
        slug: slug,
        groupId: groupId != "null" ? groupId : null
      }

      if (!oldAduio) {
        dataUpdate = {...dataUpdate, audio: audioUrl}
      }

      const scene = await db.scene.update({
        where: {
          id: id,
        },
        data: dataUpdate
      })

      return { success: true, scene }
    }
    catch(e) {
      console.log({e})
      return fail(400, { error: `Đã có lỗi xảy ra vui lòng thử lại sau` })
    }
  },

  updateInitialViewParametersScene: async ({ cookies, request, url }) => {
    try {
      const data = await request.formData()
      let initialViewParameters = data.get('initialViewParameters') as string,
        id = data.get('id') as string

      const scene = await db.scene.update({
        where: {
          id: id,
        },
        data: {
          initialViewParameters: initialViewParameters
        }
      })

      return { success: true, scene }
    }
    catch(e) {
      console.log({e})
      return fail(400, { error: `Đã có lỗi xảy ra vui lòng thử lại sau` })
    }
  },

  sortScene: async ({ cookies, request, url }) => {
    try {
      const data = await request.formData()
      
      let list = JSON.parse(data.get('list') as string) as string[]

      let scenesUpdate = list.map((v,i) => {
        return db.scene.update({
          where: {
            id: v
          },
          data: {
            sort: i
          }
        })
      })

      await db.$transaction(scenesUpdate)

      return { success: true }
    } 
    catch (error) {
      console.log({error})
      return fail(400, { error: `Đã có lỗi xảy ra vui lòng thử lại sau` })
    }
  },

  createHotspot: async ({ cookies, request, url }) => {
    try {
      const data = await request.formData()
      
      let sceneId = data.get('sceneId') as string,
          target = data.get('target') as string,
          yaw = data.get('yaw') as string,
          pitch = data.get('pitch') as string,
          direction = data.get('direction') as string,
          hotspotType = data.get('hotspotType') as string,
          type = data.get('type') as string,
          video = data.get('video') as string,
          title = data.get('title') as string,
          description = data.get('description') as string

      if (hotspotType == "link") {
        const linkHotspot = await db.linkHotspots.create({
          data: {
            sceneId: sceneId,
            yaw: +yaw,
            pitch: +pitch,
            direction: direction,
            target: target,
            type: type
          }
        })
      }
      else if (hotspotType == "info") {

        let imageUrl: sharp.OutputInfo | null = null
        let videoUrl: string | null = null
        let uuid = v4()

        const infoHotspot = await db.infoHotspots.create({
          data: {
            sceneId: sceneId,
            yaw: +yaw,
            pitch: +pitch,
            direction: direction,
            type: type,
            title: title,
            description: description,
            // image: imageUrl ? `/storage/info-hotspots/${uuid}.${imageUrl.format}` : null,
            video: video
          }
        })
      }
      else throw ""
      return { success: true }
    } 
    catch (error) {
      console.log({error})
      return fail(400, { error: `Đã có lỗi xảy ra vui lòng thử lại sau` })
    }
  },

  deleteHotspot: async ({ cookies, request, url }) => {
    try {
      const data = await request.formData()
      
      let id = data.get('id') as string,
          type = data.get('type') as string

      if (type == "link") {
        const linkHotspot = await db.linkHotspots.delete({
          where: {
            id: id
          }
        })
      }
      else if (type == "info") {
        const infoHotspot = await db.infoHotspots.delete({
          where: {
            id: id
          }
        })
      } else {
        throw ""
      }

      return { success: true }
    } 
    catch (error) {
      console.log({error})
      return fail(400, { error: `Đã có lỗi xảy ra vui lòng thử lại sau` })
    }
  },

  editHotspot: async ({ cookies, request, url }) => {
    try {
      const data = await request.formData()
      
      let id = data.get('id') as string,
          target = data.get('target') as string,
          direction = data.get('direction') as string,
          hotspotType = data.get('hotspotType') as string,
          type = data.get('type') as string,
          image = data.get('image') as File | null | undefined,
          video = data.get('video') as string,
          title = data.get('title') as string,
          description = data.get('description') as string

      if (hotspotType == "link") {
        const linkHotspot = await db.linkHotspots.update({
          where: {
            id: id
          },
          data: {
            direction: direction,
            target: target,
            type: type
          }
        })
      }
      else if (hotspotType == "info") {

        let imageUrl: sharp.OutputInfo | null = null
        let uuid = v4()
        if (image && image?.size > 0) {

          if (!existsSync(`./storage/info-hotspots`)) {
            mkdirSync(`./storage/info-hotspots`, { recursive: true })
          }

          let imageFile = sharp(await image.arrayBuffer())
          let { format } = await imageFile.metadata()
          
          imageUrl = await imageFile
            .toFile(`./storage/info-hotspots/${uuid}.${format}`)
            .then((data) => {
              return data
            })
        }

        const infoHotspot = await db.infoHotspots.update({
          where: {
            id: id,
          },
          data: {
            direction: direction,
            type: type,
            title: title,
            description: description,
            image: imageUrl ? `/storage/info-hotspots/${uuid}.${imageUrl.format}` : null,
            video: video
          }
        })
      }
      else throw ""
      return { success: true }
    } 
    catch (error) {
      console.log({error})
      return fail(400, { error: `Đã có lỗi xảy ra vui lòng thử lại sau` })
    }
  }
}