// The Map page: the mesh (who hears whom) and the floor maps (where devices are, and the coverage
// the Zigbee Sniffer estimates). Both come from the Sniffer.

import { snifferPanel } from "../store";
import { Ext, Seg } from "../ui";
import { MeshMap } from "./MapMesh";
import { FloorMaps } from "./MapFloors";

export function MapPage({ view, floor }: { view?: string; floor?: string }) {
  const v = view === "floors" ? "floors" : "mesh";
  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Map</h1>
          <p class="lede">{v === "mesh"
            ? "Who hears whom, from the routers' Link Status, laid out by your floors and rooms"
            : "Where your devices are, and the Zigbee coverage the Sniffer estimates from what it hears"}</p>
        </div>
        <div class="head-actions">
          <Seg label="Map" value={v} onChange={(x) => { location.hash = x === "floors" ? "#/map/floors" : "#/map"; }}
            options={[{ v: "mesh", label: "Mesh" }, { v: "floors", label: "Floor plans" }]} />
          {snifferPanel.value && <Ext href={snifferPanel.value}>Zigbee Sniffer</Ext>}
        </div>
      </div>
      {v === "mesh" ? <MeshMap /> : <FloorMaps fid={floor} />}
    </div>
  );
}
