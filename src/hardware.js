// Hardware check — what this PC can run locally (graphics card, its memory,
// system memory, processor). Windows only for the graphics part: the display
// adapters' registry keys carry the real dedicated memory size (WMI's
// AdapterRAM caps at 4 GB, so it under-reports modern cards).

const os = require('os');
const { execFile } = require('child_process');

const GPU_CLASS = 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*';
const PS_SCRIPT =
  `Get-ItemProperty '${GPU_CLASS}' -ErrorAction SilentlyContinue | ForEach-Object { ` +
  `[pscustomobject]@{ name = $_.DriverDesc; qw = $_.'HardwareInformation.qwMemorySize'; ` +
  `m32 = $_.'HardwareInformation.MemorySize'; vendor = $_.ProviderName } } | ConvertTo-Json -Compress`;

const GB = 1024 ** 3;

function runPowerShell(script, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

// Integrated graphics share system memory; their registry "memory" is not real VRAM.
function isIntegrated(name) {
  return /\b(UHD|HD Graphics|Iris|Intel\(R\) Graphics|Arc\(TM\) Graphics)\b/i.test(name)
    || /^AMD Radeon\(TM\)( \d+M?)? Graphics$/i.test(name)
    || /Radeon\(TM\) Graphics/i.test(name) && !/\bRX\b/i.test(name);
}
function isVirtual(name) {
  return /virtual|basic display|basic render|parsec|meta|remote|indirect|spacedesk|citrix/i.test(name);
}
function vendorOf(name, vendor) {
  const s = `${name} ${vendor || ''}`;
  if (/nvidia|geforce|rtx|quadro/i.test(s)) return 'nvidia';
  if (/amd|radeon|advanced micro/i.test(s)) return 'amd';
  if (/intel/i.test(s)) return 'intel';
  return 'other';
}

function bytesFrom(qw, m32) {
  if (typeof qw === 'number' && qw > 0) return qw;
  if (typeof m32 === 'number' && m32 > 0) return m32;
  if (Array.isArray(m32) && m32.length >= 4) return Buffer.from(m32.slice(0, 4)).readUInt32LE(0);
  return 0;
}

async function listGpus() {
  if (process.platform !== 'win32') return [];
  const out = (await runPowerShell(PS_SCRIPT)).trim();
  if (!out) return [];
  let rows;
  try { rows = JSON.parse(out); } catch { return []; }
  if (!Array.isArray(rows)) rows = [rows];
  return rows
    .filter((r) => r && r.name && !isVirtual(r.name))
    .map((r) => {
      const integrated = isIntegrated(r.name);
      const bytes = integrated ? 0 : bytesFrom(r.qw, r.m32);
      return {
        name: String(r.name).trim(),
        vendor: vendorOf(r.name, r.vendor),
        integrated,
        vramGB: Math.round((bytes / GB) * 10) / 10,
      };
    })
    .sort((a, b) => b.vramGB - a.vramGB);
}

let cached = null;

/** { cpu, cores, ramGB, gpus: [...], gpu (best one or null), tier } — cached after the first call. */
async function getSystemInfo() {
  if (cached) return cached;
  const cpus = os.cpus() || [];
  const gpus = await listGpus();
  const gpu = gpus.find((g) => !g.integrated && g.vramGB > 0) || null;
  const ramGB = Math.round(os.totalmem() / GB);
  cached = {
    cpu: cpus[0] ? cpus[0].model.replace(/\s+/g, ' ').trim() : '',
    cores: cpus.length,
    ramGB,
    gpus,
    gpu,
    tier: tierFor(gpu ? gpu.vramGB : 0, ramGB),
  };
  return cached;
}

// A rough guide to what fits, for a 4-bit model plus room for context:
//   ~24 GB card → up to ~30B, ~16 GB → ~14B, ~12 GB → ~12B, ~8 GB → ~8B, ~6 GB → ~4B.
// Without a card, small models still run on the processor, slowly.
function tierFor(vramGB, ramGB) {
  if (vramGB >= 20) return { key: 'large', maxB: 30 };
  if (vramGB >= 14) return { key: 'medium', maxB: 14 };
  if (vramGB >= 10) return { key: 'medium', maxB: 12 };
  if (vramGB >= 7) return { key: 'small', maxB: 8 };
  if (vramGB >= 5) return { key: 'small', maxB: 4 };
  if (ramGB >= 16) return { key: 'cpu', maxB: 4 };
  return { key: 'online', maxB: 0 };
}

module.exports = { getSystemInfo, tierFor };
