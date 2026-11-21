# CHLADNI — Sound made visible

An interactive, GPU-driven Chladni plate visualization built with Three.js. Play YouTube videos and optionally share tab audio for live spectral response as glowing orbs gather along mathematical nodal patterns on a 3D aluminum plate. Audio analysis runs in your browser.

## Experience

- Load an embeddable YouTube video and use the built-in playback, seek, and volume controls.
- Share this browser tab’s audio to drive the plate from a live spectrum. Audio stays in the browser; there is no upload backend.
- Watch a GPU particle simulation settle toward nodal lines on an animated plate surface.
- Drag to tilt, scroll to zoom, or select the top and side camera views. The camera stays above the plate.
- Adjust orb size, starting at 0.6×, and increase the visible plate flex with the **Flex Exaggeration** slider. The particle field is always on, uses cyan-violet light orbs, and keeps glow at high intensity.

YouTube does not expose raw audio to an embedded player. Without tab-audio sharing, the visualization follows playback timing with an ambient pulse; it does not analyze the track’s spectrum or pre-analyze the full track.

## Plate model

The fixed ideal model is an isotropic aluminum plate, 200 mm in diameter and 1 mm thick, with a free outer rim. Mode shapes use a Kirchhoff–Love thin-plate solution, `J_m(λr) - c I_m(λr)`, with free-edge boundary conditions. Resonance frequencies follow `f = λ²/(2πa²) √(D/(ρh))`, where `D = Eh³/[12(1-ν²)]`. Live spectral peaks are weighted by a damped-oscillator response and blended into the plate modes.

This is a physical approximation. Grain contact and damping are simplified, and the plate’s driver location and measured transfer function are unknown. The flex slider exaggerates out-of-plane motion for visibility; it does not change the nodal pattern or particle settling.

## Run locally

Requires Node.js 20.19+ or 22.12+.

```bash
npm install
npm run dev
```

Run the checks and create a production build with:

```bash
npm test
npm run build
npm run preview
```

The static site is written to `dist/`.

## Deploy to GitHub Pages

1. Push this project to a public repository named `CHLADNI` on its `main` branch.
2. In **Settings → Pages**, choose **GitHub Actions** as the deployment source.
3. Push to `main`, or run **Deploy CHLADNI to GitHub Pages** manually from the Actions tab.
4. GitHub Pages will publish the site at `https://YOUR-USERNAME.github.io/CHLADNI/`.

`vite.config.js` sets the `/CHLADNI/` base path. For another repository name, change it to `/<repository-name>/`; for a username site repository (`YOUR-USERNAME.github.io`), change it to `/`. The included workflow installs the locked dependencies, builds the app, and publishes `dist/`.

## Browser support

YouTube playback requires an internet connection and the video owner must allow embedding. Live tab-audio analysis requires browser support for display-audio capture and a secure context. GitHub Pages is served over HTTPS. If capture is unavailable or declined, synchronized playback and the ambient visualization remain available.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
