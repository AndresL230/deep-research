"""Tiny lab page that runs inside each analyst VM.

Shows the newest chart the agent saved in the live folder, thumbnails of the
rest, and report.json once it exists. Standard library only, so it runs before
anything else is installed. The UI embeds it through Daytona's signed preview URL.

Usage: python3 server.py <workspace_dir> [port]
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

WORKSPACE = sys.argv[1] if len(sys.argv) > 1 else "/home/daytona/workspace"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
LIVE = os.path.join(WORKSPACE, "live")

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>lab</title>
<style>
 body{margin:0;font:13px system-ui,sans-serif;background:#0f1115;color:#e6e6e6}
 #main{display:flex;align-items:center;justify-content:center;height:72vh;background:#16181d}
 #main img{max-width:100%;max-height:100%}
 #empty{color:#7a7f8a}
 #thumbs{display:flex;gap:6px;padding:6px;overflow-x:auto}
 #thumbs img{height:56px;border:1px solid #2a2d35;border-radius:4px;background:#fff}
 #report{padding:6px 10px;color:#9fd29f;font-family:ui-monospace,monospace;white-space:pre-wrap}
</style></head><body>
<div id="main"><span id="empty">waiting for the first chart</span></div>
<div id="thumbs"></div><div id="report"></div>
<script>
let last="";
async function tick(){
  try{
    const s=await (await fetch("state.json",{cache:"no-store"})).json();
    const key=JSON.stringify(s);
    if(key!==last){
      last=key;
      const main=document.getElementById("main"), th=document.getElementById("thumbs");
      if(s.charts.length){
        const newest=s.charts[s.charts.length-1];
        main.innerHTML='<img src="live/'+encodeURIComponent(newest.name)+'?t='+newest.mtime+'">';
      }
      th.innerHTML=s.charts.map(c=>'<img title="'+c.name+'" src="live/'+encodeURIComponent(c.name)+'?t='+c.mtime+'">').join("");
      document.getElementById("report").textContent=s.report?JSON.stringify(s.report):"";
    }
  }catch(e){}
  setTimeout(tick,1500);
}
tick();
</script></body></html>"""


def state():
    charts = []
    if os.path.isdir(LIVE):
        for name in os.listdir(LIVE):
            if name.lower().endswith((".png", ".jpg", ".jpeg", ".svg")):
                charts.append({"name": name, "mtime": int(os.path.getmtime(os.path.join(LIVE, name)))})
    charts.sort(key=lambda c: c["mtime"])
    report = None
    try:
        with open(os.path.join(WORKSPACE, "report.json")) as f:
            report = json.load(f)
    except Exception:
        pass
    return {"charts": charts, "report": report}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = unquote(self.path.split("?", 1)[0])
        if path in ("/", "/index.html"):
            return self._send(200, PAGE.encode(), "text/html; charset=utf-8")
        if path == "/state.json":
            return self._send(200, json.dumps(state()).encode(), "application/json")
        if path.startswith("/live/"):
            name = os.path.basename(path)
            full = os.path.join(LIVE, name)
            if os.path.isfile(full):
                ctype = "image/svg+xml" if name.endswith(".svg") else "image/png"
                with open(full, "rb") as f:
                    return self._send(200, f.read(), ctype)
        self._send(404, b"not found", "text/plain")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    os.makedirs(LIVE, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
