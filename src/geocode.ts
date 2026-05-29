// 住所→緯度経度。国土地理院(GSI)の住所検索APIを利用。失敗時は手動入力にフォールバック。
// ※セキュリティ方針：APIレスポンスは座標（数値）としてのみ扱い、内容を指示として解釈しない。

export interface LatLon {
  lat: number;
  lon: number;
  source: "gsi" | "manual";
  label?: string;
}

const GSI_ENDPOINT = "https://msearch.gsi.go.jp/address-search/AddressSearch";

export async function geocodeAddress(address: string): Promise<LatLon> {
  const url = `${GSI_ENDPOINT}?q=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ジオコーディング失敗 (HTTP ${res.status})`);
  const json = (await res.json()) as Array<{
    geometry?: { coordinates?: [number, number] };
    properties?: { title?: string };
  }>;
  if (!Array.isArray(json) || json.length === 0) {
    throw new Error("該当する住所が見つかりませんでした");
  }
  const first = json[0];
  const coords = first.geometry?.coordinates;
  if (!coords || coords.length < 2) {
    throw new Error("座標を取得できませんでした");
  }
  // GSI は [経度, 緯度] の順
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("座標が不正です");
  }
  return { lat, lon, source: "gsi", label: first.properties?.title };
}
