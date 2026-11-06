import fs from "node:fs";
const [url, out, seconds] = [process.argv[2], process.argv[3], +process.argv[4]];
const ws = new WebSocket(url); ws.binaryType = "arraybuffer";
const fd = fs.openSync(out, "w"); let bytes = 0;
ws.onmessage = (e) => { if (typeof e.data === "string") { console.log("ctl", e.data.slice(0,120)); return; } fs.writeSync(fd, Buffer.from(e.data)); bytes += e.data.byteLength; };
ws.onclose = () => { console.log("closed", bytes); process.exit(0); };
setTimeout(() => { console.log("done", bytes); ws.close(); fs.closeSync(fd); process.exit(0); }, seconds * 1000);
