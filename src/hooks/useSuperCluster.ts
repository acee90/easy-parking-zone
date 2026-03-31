import { useRef, useMemo, useCallback } from "react";
import Supercluster from "supercluster";
import type { MapBounds } from "@/types/parking";
import type { ParkingPoint } from "@/server/parking";

/** SuperCluster 클러스터의 집계 속성 */
export interface ClusterProperties {
  cluster: true;
  cluster_id: number;
  point_count: number;
  sum_score: number;
  count_score: number;
  easy: number;
  hard: number;
}

/** 개별 포인트의 속성 */
export interface PointProperties {
  cluster: false;
  id: string;
  name: string;
  score: number | null;
}

export type ClusterFeature = Supercluster.ClusterFeature<ClusterProperties>;
export type PointFeature = Supercluster.PointFeature<PointProperties>;
export type MapFeature = ClusterFeature | PointFeature;

const SUPERCLUSTER_OPTIONS: Supercluster.Options<
  PointProperties,
  ClusterProperties
> = {
  radius: 200,
  maxZoom: 15,
  minZoom: 0,
  map: (props) => ({
    cluster: true as const,
    cluster_id: 0,
    point_count: 1,
    sum_score: props.score ?? 0,
    count_score: props.score !== null ? 1 : 0,
    easy: props.score !== null && props.score >= 3.5 ? 1 : 0,
    hard: props.score !== null && props.score < 2.5 ? 1 : 0,
  }),
  reduce: (acc, props) => {
    acc.sum_score += props.sum_score;
    acc.count_score += props.count_score;
    acc.easy += props.easy;
    acc.hard += props.hard;
  },
};

export function useSuperCluster(points: ParkingPoint[] | null) {
  // points 참조가 바뀌면 인덱스 재구축 (useMemo의 deps로 충분)
  const index = useMemo(() => {
    if (!points || points.length === 0) return null;

    const sc = new Supercluster<PointProperties, ClusterProperties>(SUPERCLUSTER_OPTIONS);
    const features: Supercluster.PointFeature<PointProperties>[] = points.map(
      (p) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
        properties: {
          cluster: false as const,
          id: p.id,
          name: p.name,
          score: p.score,
        },
      }),
    );
    sc.load(features);
    return sc;
  }, [points]);

  const getClusters = useCallback(
    (bounds: MapBounds, zoom: number): MapFeature[] => {
      if (!index) return [];
      return index.getClusters(
        [bounds.west, bounds.south, bounds.east, bounds.north],
        Math.round(zoom),
      ) as MapFeature[];
    },
    [index],
  );

  const getExpansionZoom = useCallback(
    (clusterId: number): number => {
      if (!index) return 16;
      return index.getClusterExpansionZoom(clusterId);
    },
    [index],
  );

  return { index, getClusters, getExpansionZoom, loaded: !!index };
}
