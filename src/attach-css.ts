// src/attach-css.ts - the look of the attach button and file chips, shared by the dashboard and the War Room.
// Colours come from each page's own variables (with fallbacks), so the chips match the room they are in.
export const ATTACH_CSS = `
.attachbtn{min-width:44px;font-size:17px;padding:0 10px}
.attachtray{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.attachtray[hidden]{display:none}
.kchip{display:inline-flex;align-items:center;gap:7px;max-width:100%;padding:4px 6px 4px 8px;border:1px solid var(--line,#30363d);border-radius:8px;background:#0d1117;color:var(--txt,#e8dcc0);font:12px system-ui}
.kchip img{width:26px;height:26px;object-fit:cover;border-radius:4px}
.kchip .kname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}
.kchip .kstate{color:#b9ad8c;white-space:nowrap}
.kchip.uploading{border-style:dashed}.kchip.failed{border-color:#f85149}.kchip.failed .kstate{color:#ff7b72}
.kchip .kx{min-width:26px;min-height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:#b9ad8c;cursor:pointer;font-size:12px}
.kchip .kx:hover,.kchip .kx:focus-visible{background:#30363d;color:#fff;outline:2px solid #e4c468;outline-offset:1px}
.dropping{outline:2px dashed #e4c468;outline-offset:4px}
.sentfiles{margin-top:4px;font:12px system-ui;color:#b9ad8c}
`;
