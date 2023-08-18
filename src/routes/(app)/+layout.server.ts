import db from "$lib/server/prismadb"
import type { InitialViewParametersType, LevelsType, SceneDataType } from "../admin/(admin)/+page.server"

export const load = async ({request}) => {
  // const userAgent = request.headers.get('user-agent')
  // console.log({userAgent})
  const [scenes, groups, settings] = await Promise.all([
    db.scene.findMany({
      where: {
        groupId: {
          not: null
        }
      },
      include: {
        infoHotspots: true,
        linkHotspots: true,
      },
      orderBy: {
        // group: {
        //   sort: 'asc'
        // },
        sort: 'asc',
      }
    }),
    db.groupScene.findMany(),
    db.setting.findMany()
  ])

  let scenesData: SceneDataType[] = scenes.map(v => {
    return {
      ...v,
      levels: JSON.parse(v.levels) as LevelsType,
      initialViewParameters: JSON.parse(v.initialViewParameters) as InitialViewParametersType,
    }
  })

  let scenesGroup: SceneDataType[] = []
  groups.forEach(v => {
    scenesGroup.push(...scenesData.filter(v2 => v2.groupId == v.id))
  })

  return { scenes: scenesGroup, settings, groups }
}