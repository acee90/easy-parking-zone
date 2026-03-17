import { describe, expect, it } from "vitest";
import { calcPanOffset } from "./map-utils";

describe("calcPanOffset", () => {
  const mapSize = { width: 1000, height: 800 };

  it("마커가 중앙 근처면 null 반환 (패닝 불필요)", () => {
    // 중앙: (500, 400), 오차 50px 이내
    expect(calcPanOffset({ x: 500, y: 400 }, mapSize)).toBeNull();
    expect(calcPanOffset({ x: 520, y: 380 }, mapSize)).toBeNull();
    expect(calcPanOffset({ x: 549, y: 449 }, mapSize)).toBeNull();
  });

  it("마커가 왼쪽 가장자리에 있으면 왼쪽으로 패닝", () => {
    const result = calcPanOffset({ x: 100, y: 400 }, mapSize);
    expect(result).not.toBeNull();
    expect(result!.dx).toBe(-400); // 100 - 500
    expect(result!.dy).toBe(0);
  });

  it("마커가 오른쪽 아래에 있으면 해당 방향으로 패닝", () => {
    const result = calcPanOffset({ x: 900, y: 700 }, mapSize);
    expect(result).not.toBeNull();
    expect(result!.dx).toBe(400);  // 900 - 500
    expect(result!.dy).toBe(300);  // 700 - 400
  });

  it("패널 너비를 지도 좌표에 포함하지 않음 (기존 버그 회귀 방지)", () => {
    // 기존 버그: visibleCenterX = 640 + (1000 - 640) / 2 = 820
    // 마커가 중앙(500,400)인데 dx = 500 - 820 = -320 으로 잘못 계산
    const center = { x: 500, y: 400 };
    const result = calcPanOffset(center, mapSize);
    // 중앙에 있으므로 null이어야 함 — 640px 오프셋이 들어가면 여기서 실패
    expect(result).toBeNull();
  });

  it("지도 크기가 작아도 올바르게 계산", () => {
    const small = { width: 400, height: 300 };
    const result = calcPanOffset({ x: 50, y: 50 }, small);
    expect(result).not.toBeNull();
    expect(result!.dx).toBe(-150); // 50 - 200
    expect(result!.dy).toBe(-100); // 50 - 150
  });

  it("dx/dy 중 하나만 50 초과해도 패닝 수행", () => {
    // dx=51, dy=0 → 패닝 필요
    expect(calcPanOffset({ x: 551, y: 400 }, mapSize)).not.toBeNull();
    // dx=0, dy=51 → 패닝 필요
    expect(calcPanOffset({ x: 500, y: 451 }, mapSize)).not.toBeNull();
  });
});
