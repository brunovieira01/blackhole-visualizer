// Is the scene actually running on the GPU, and what does an idle Electron
// window cost on this machine?
//
//   npx electron tools/probe-gpu.js
//
// Prints Chromium's own view of acceleration plus the GL strings the renderer
// really got, then holds an empty window open so its GPU-process CPU can be
// measured as a baseline against the visualizer's.

'use strict';

const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const status = app.getGPUFeatureStatus();
  console.log('\n--- gpu feature status ---');
  for (const [k, v] of Object.entries(status)) console.log(`  ${k}: ${v}`);

  try {
    const info = await app.getGPUInfo('complete');
    const g = info.gpuDevice && info.gpuDevice[0];
    console.log('\n--- device ---');
    if (g) console.log(`  vendor 0x${(g.vendorId || 0).toString(16)} device 0x${(g.deviceId || 0).toString(16)}`);
    console.log(`  driver: ${info.driverVersion || '?'}`);
    console.log(`  gl_renderer: ${info.auxAttributes?.glRenderer || '?'}`);
    console.log(`  gl_vendor:   ${info.auxAttributes?.glVendor || '?'}`);
    console.log(`  passthrough command decoder: ${info.auxAttributes?.passthroughCmdDecoder}`);
  } catch (err) {
    console.log('  getGPUInfo failed:', err.message);
  }

  const win = new BrowserWindow({ width: 640, height: 400, show: false });
  win.removeMenu();
  await win.loadURL('about:blank');

  const strings = await win.webContents.executeJavaScript(`(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return { webgl2: false };
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      webgl2: true,
      renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: d ? gl.getParameter(d.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    };
  })()`);
  console.log('\n--- what the renderer got ---');
  console.log(' ', JSON.stringify(strings));

  // The line that matters is gpu_compositing. WebGL can be fully hardware
  // accelerated (ANGLE -> D3D11) while the page is still *composited* on the
  // CPU, and then every frame the GPU draws has to be read back and blitted
  // in software -- which at 2560x1440 costs more than the scene does.
  console.log('\nIf gpu_compositing says disabled_software, Chromium is compositing');
  console.log('on the CPU on this machine, and no flag here will change that.\n');
  app.quit();
});
