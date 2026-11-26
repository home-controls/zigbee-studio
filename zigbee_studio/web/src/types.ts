// Shapes the backend sends (app/lean.py, app/hub.py, app/hass.py).

export type State = Record<string, any>;

export interface Dev {
  ieee: string;
  name: string;
  type: "Coordinator" | "Router" | "EndDevice" | string;
  nwk?: number;
  model?: string;
  vendor?: string;
  desc?: string;
  model_id?: string;
  mfr?: string;
  power?: string;
  sw?: string;
  date?: string;
  supported: boolean;
  disabled: boolean;
  interview: string;
  ota: boolean;
  src?: string;
  x?: string; // exposes hash
}

export interface Expose {
  type: string;
  name?: string;
  label?: string;
  property?: string;
  access?: number;
  endpoint?: string;
  features?: Expose[];
  values?: (string | number)[];
  value_min?: number;
  value_max?: number;
  value_step?: number;
  unit?: string;
  presets?: { name: string; value: number | string; description?: string }[];
  value_on?: any;
  value_off?: any;
  value_toggle?: any;
  description?: string;
  category?: "config" | "diagnostic";
  item_type?: Expose;
  length_min?: number;
  length_max?: number;
}

export interface Group {
  key: string;
  id: number;
  name: string;
  desc?: string;
  members: { ieee: string; ep: number }[];
  scenes: { id: number; name: string }[];
}

export interface Bridge {
  connected: boolean;
  state: string | null;
  version?: string;
  commit?: string;
  herdsman?: string;
  zhc?: string;
  coordinator: { type?: string; ieee?: string; revision?: string };
  network: { channel?: number; pan_id?: number; extended_pan_id?: string };
  permit_join: boolean;
  permit_join_end?: number | null;
  restart_required: boolean;
  log_level?: string;
  os: { version?: string; node_version?: string; cpus?: string; memory_mb?: number };
  adapter?: string;
  transmit_power?: number;
  availability: boolean;
  last_seen?: string;
  base_topic?: string;
  extensions: string[];
  converters: string[];
}

export interface Health {
  healthy?: boolean;
  response_time?: number;
  process: { uptime_sec?: number; memory_used_mb?: number; memory_percent?: number };
  os: { load_average?: number[]; memory_used_mb?: number; memory_percent?: number };
  mqtt: { connected?: boolean; queued?: number; published?: number; received?: number };
  devices: Record<string, { mps?: number; msgs?: number; leaves?: number; nwk_changes?: number }>;
}

export interface Rooms {
  floors: { id: string; name: string; level: number | null; icon?: string | null }[];
  areas: { id: string; name: string; floor: string | null; icon?: string | null }[];
  dev: Record<string, { area: string | null; id: string; ha_name?: string | null }>;
}

export interface Sniffer {
  s: string; // ok / note / warning / problem / not heard
  findings: string[];
  signal?: number | null;
  by?: string | null;
  resent?: number | null;
  noack?: number | null;
  lost?: number | null;
  cost?: number | null;
  nb?: number | null;
  hop?: string | null;
  msgs?: number | null;
  heard?: string | null;
}

export interface LogEntry {
  ts: number;
  level: string;
  ns: string;
  msg: string;
}

export interface Ev {
  ts: number;
  type: string;
  key?: string | null;
  friendly_name?: string;
  state?: string;
  status?: string;
  [k: string]: any;
}

// ------------------------------------------------------------------ network adapter (zbbridge/1)

/** Studio's link to the network adapter (the token never reaches the page). */
export interface AdapterInfo { linked: boolean; host: string | null; suggested: string | null; error: string; ok_at: number | null }

export interface AdapterAsh {
  bytes: number; frames: number; data: number; ack: number; nak: number; rst: number; rstack: number;
  error: number; retx: number; crc_err: number; cancel: number; substitute: number; oversize: number;
}

export interface AdapterStatus {
  fw: { version: string; idf: string; built: string; partition: string; pending_verify: boolean };
  sys: { chip: string; reset_reason: string; watchdog?: string; temp_c: number; heap_free: number; heap_min: number };
  uptime: number; epoch: number; stats_since: number;
  health: { score: number; reason: string };
  eth: { link: boolean; has_ip: boolean; speed: number; full_duplex: boolean; ip: string; mask: string; gw: string; mac: string; mode: "static" | "dhcp"; hostname: string };
  dongle: { present: boolean; open: boolean; usb_id: string; manufacturer: string; product: string; serial: string; since: number; baud: number };
  client: { connected: boolean; ip: string; port: number; since: number; allowed: string; tcp_port: number };
  ncp: { ezsp: number; stack: string; reset_code: number; error_code: number; network: "up" | "down" | "unknown" };
  counters: {
    host: AdapterAsh; ncp: AdapterAsh;
    ezsp_cmds: number; zb_rx: number; zb_unicast: number; zb_broadcast: number; zb_multicast: number;
    zb_sent_ok: number; zb_sent_fail: number; route_errors: number; joins: number; leaves: number; id_conflicts: number;
    rtt_avg_ms: number; rtt_max_ms: number; rtt_n: number; rtt_hist: number[]; ack_avg_ms: number; ack_max_ms: number;
    clients_accepted: number; clients_refused: number; client_drops: number;
  };
}

export interface AdapterHistory {
  t: number[]; in: number[]; out: number[]; rx: number[]; ok: number[]; fail: number[];
  cmds: number[]; rtt: number[]; rttmax: number[]; err: number[];
}

export interface AdapterEvent { id: number; up: number; epoch: number; level: 0 | 1 | 2; text: string }

export interface AdapterDevice {
  short: string; ieee: string; rx: number; tx_ok: number; tx_fail: number; route_err: number;
  lqi: number; rssi: number; lqi_avg: number; rssi_avg: number; first: number; last: number;
  last_fail: number; last_fail_status: number;
}
