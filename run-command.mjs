// run-command.mjs — cross-platform, works on Windows and Linux (Codespaces)
import {
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  copyFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { exec, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  config,
  serverUrl,
  flatAltPaths,
  splashRandom,
} from './src/routes.mjs';
import { epoxyPath } from '@mercuryworkshop/epoxy-transport';
import { libcurlPath } from '@mercuryworkshop/libcurl-transport';
import { baremuxPath } from '@mercuryworkshop/bare-mux/node';
import { uvPath } from '@titaniumnetwork-dev/ultraviolet';
import paintSource from './src/source-rewrites.mjs';
import { loadTemplates, tryReadFile } from './src/templates.mjs';

const scramjetPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'node_modules/@mercuryworkshop/scramjet/dist'
);

// This constant is copied over from /src/server.mjs.
const shutdown = fileURLToPath(new URL('./src/.shutdown', import.meta.url));

/**
 * Helper: start backend.js in a detached, cross-platform way.
 * By default we detach + ignore stdio so the server keeps running after this process exits.
 * If you want to run in the foreground for debugging (show logs), pass { foreground: true }.
 */
function startDetachedServer({ foreground = false } = {}) {
  const modulePath = fileURLToPath(new URL('./backend.js', import.meta.url));

  // If user explicitly wants foreground output (for debugging), attach stdio.
  if (foreground) {
    const server = fork(modulePath, [], {
      cwd: process.cwd(),
      detached: false,
      stdio: 'inherit',
    });
    // Do not unref so the parent keeps the child alive until it exits.
    return server;
  }

  // Detached background server — works on Windows and Linux.
  const server = fork(modulePath, [], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore', // fully detach stdio so child keeps running after parent exits
  });

  // Don't keep references that would prevent parent from exiting
  server.unref();

  try {
    // Some older Node versions require disconnecting on Windows to fully detach
    if (typeof server.disconnect === 'function') server.disconnect();
  } catch (e) {
    // ignore
  }

  return server;
}

/**
 * Helper: run a shell command (promisified-ish)
 * Uses shell: true to ensure cross-platform resolution of npm, npx, etc.
 */
function execCmd(cmd, { silent = false } = {}) {
  return new Promise((resolve) => {
    exec(cmd, { shell: true }, (error, stdout, stderr) => {
      if (error) {
        if (!silent) console.error('[Exec Error]', error);
        return resolve({ error, stdout, stderr });
      }
      if (!silent && stdout) console.log('[Exec]', stdout.trim());
      resolve({ stdout, stderr });
    });
  });
}

// Process commands passed after `node run-command.mjs`
commands: for (let i = 2; i < process.argv.length; i++) {
  switch (process.argv[i]) {
    case 'start': {
      // Production: delegate to PM2
      if (config.production) {
        // Use shell: true via execCmd for cross-platform reliability.
        await execCmd('npx pm2 start ecosystem.config.js --env production');
        break;
      }

      // Non-production: start detached server in a cross-platform way.
      // If user requested foreground (eg. --foreground passed after start), run attached.
      const extraArgs = process.argv.slice(i + 1);
      const foreground = extraArgs.includes('--foreground') || extraArgs.includes('foreground');

      try {
        if (foreground) {
          console.log('[Start] Starting server in foreground (attached).');
          startDetachedServer({ foreground: true });
        } else {
          console.log('[Start] Starting detached background server.');
          startDetachedServer({ foreground: false });
          console.log('[Start] Server started (detached).');
        }
      } catch (e) {
        console.error('[Start Error]', e);
        process.exitCode = 1;
      }
      break;
    }

    case 'stop': {
      writeFileSync(shutdown, '');
      let timeoutId;
      let hasErrored = false;
      try {
        const response = await Promise.race([
          fetch(new URL(serverUrl.pathname + 'test-shutdown', serverUrl)),
          new Promise((resolve) => {
            timeoutId = setTimeout(() => {
              resolve('Error');
            }, 5000);
          }),
        ]);
        clearTimeout(timeoutId);
        if (response === 'Error') throw new Error('Server is unresponsive.');
      } catch (e) {
        // Remove the temporary shutdown file since the server didn't remove it.
        try {
          unlinkSync(shutdown);
        } catch (ex) {
          // ignore
        }
        // If fetch threw due to no server, it's a TypeError. We don't want to spam logs.
        if (e instanceof TypeError) {
          clearTimeout(timeoutId);
        } else {
          console.error('[Stop Error]', e);
          if (!process.argv.slice(i + 1).includes('kill')) hasErrored = true;
        }
      }

      // Stop PM2 in production
      if (config.production && !process.argv.slice(i + 1).includes('kill')) {
        const { error } = await execCmd('npx pm2 stop ecosystem.config.js', { silent: false });
        if (error) {
          console.error('[Stop Error] PM2 stop failed.');
          hasErrored = true;
        }
      }

      if (hasErrored) {
        process.exitCode = 1;
        break commands;
      }
      break;
    }

    case 'build': {
      const dist = fileURLToPath(new URL('./views/dist', import.meta.url));
      rmSync(dist, { force: true, recursive: true });
      mkdirSync(dist, { recursive: true });

      const ignoredDirectories = ['dist', 'assets', 'uv', 'scram', 'archive'];
      const ignoredFileTypes = /\.map$/;

      const compile = (dir, base = '', outDir = '', initialDir = dir, applyRewrites = initialDir === './views') =>
        readdirSync(base + dir).forEach((file) => {
          let oldLocation = new URL(file, new URL(base + dir + '/', import.meta.url));
          if ((ignoredDirectories.includes(file) && applyRewrites) || ignoredFileTypes.test(file)) return;
          const fileStats = lstatSync(oldLocation);
          const targetPath = fileURLToPath(
            new URL(
              './views/dist/' +
                outDir +
                (base + dir + '/').slice(initialDir.length + 1) +
                ((!config.usingSEO && flatAltPaths['files/' + file]) || file),
              import.meta.url
            )
          );
          if (fileStats.isFile() && !existsSync(targetPath)) {
            if (/\.(?:html|js|css|json|txt|xml)$/.test(file) && applyRewrites) {
              writeFileSync(
                targetPath,
                paintSource(loadTemplates(tryReadFile(base + dir + '/' + file, import.meta.url, false)))
              );
            } else copyFileSync(base + dir + '/' + file, targetPath);
          } else if (fileStats.isDirectory()) {
            if (!existsSync(targetPath)) mkdirSync(targetPath);
            compile(file, base + dir + '/', outDir, initialDir, applyRewrites);
          }
        });

      const localAssetDirs = ['assets', 'scram', 'uv'];
      for (const path of localAssetDirs) {
        mkdirSync('./views/dist/' + path, { recursive: true });
        compile('./views/' + path, '', path + '/', './views/' + path, true);
      }

      const compilePaths = {
        epoxy: epoxyPath,
        libcurl: libcurlPath,
        baremux: baremuxPath,
        uv: uvPath,
        scram: scramjetPath,
        chii: 'node_modules/chii',
      };
      for (const path of Object.entries(compilePaths)) {
        const prefix = path[0] + '/';
        const prefixUrl = new URL('./views/dist/' + prefix, import.meta.url);
        if (!existsSync(prefixUrl)) mkdirSync(prefixUrl, { recursive: true });
        compile(path[1].slice(path[1].indexOf('node_modules')), '', prefix);
      }

      if (config.minifyScripts)
        await build({
          entryPoints: [
            './views/dist/uv/**/*.js',
            './views/dist/scram/**/*.js',
            './views/dist/scram/**/*.wasm.wasm',
            './views/dist/assets/js/**/*.js',
            './views/dist/assets/css/**/*.css',
          ],
          platform: 'browser',
          sourcemap: true,
          bundle: true,
          minify: true,
          loader: { '.wasm.wasm': 'copy' },
          external: ['*.png', '*.jpg', '*.jpeg', '*.webp', '*.svg'],
          outdir: dist,
          allowOverwrite: true,
        });

      compile('./views');

      mkdirSync('./views/dist/archive', { recursive: true });
      if (existsSync('./views/archive')) compile('./views/archive', '', 'archive/');

      const createFile = (location, text) => {
        writeFileSync(fileURLToPath(new URL('./views/dist/' + location, import.meta.url)), paintSource(loadTemplates(text)));
      };

      createFile('assets/json/splash.json', JSON.stringify(splashRandom));

      if (config.disguiseFiles) {
        const compress = async (dir, recursive = false) => {
          for (const file of readdirSync(dir)) {
            const fileLocation = dir + '/' + file;
            if (file.endsWith('.html'))
              writeFileSync(
                fileLocation,
                Buffer.from(
                  await new Response(new Blob([tryReadFile(fileLocation, import.meta.url, false)])).arrayBuffer()
                )
              );
            else if (recursive && lstatSync(fileLocation).isDirectory() && file !== 'deobf') await compress(fileLocation, true);
          }
        };
        await compress('./views/dist');
        await compress('./views/dist/pages', true);
        await compress('./views/dist/archive', true);
      }

      break;
    }

    case 'clean': {
      const targetDirs = ['./lib/rammerhead/cache-js'];
      for (const targetDir of targetDirs) {
        try {
          const targetPath = fileURLToPath(new URL(targetDir, import.meta.url));
          rmSync(targetPath, { force: true, recursive: true });
          mkdirSync(targetPath, { recursive: true });
          writeFileSync(fileURLToPath(new URL(targetDir + '/.gitkeep', import.meta.url)), '');
          console.log('[Clean]', `Reset folder ${targetDir} at ${new Date().toISOString()}.`);
        } catch (e) {
          console.error('[Clean Error]', e);
        }
      }
      break;
    }

    case 'format': {
      try {
        await execCmd('npx prettier --write .');
      } catch (e) {
        console.error('[Format Error]', e);
      }
      break;
    }

    case 'kill': {
      try {
        if (process.platform === 'win32') {
          // Use cmd to run both pm2 delete and taskkill
          await execCmd('( npx pm2 delete ecosystem.config.js ) & taskkill /F /IM node*');
        } else {
          await execCmd('npx pm2 delete ecosystem.config.js; pkill node');
        }
        console.log('[Kill] Kill sequence complete.');
      } catch (e) {
        console.error('[Kill Error]', e);
      }
      break;
    }

    case 'workflow': {
      // Make a temporary server that reports startup errors, then restart detached.
      const tempServerModule = fileURLToPath(new URL('./backend.js', import.meta.url));

      const tempServer = fork(tempServerModule, [], {
        cwd: process.cwd(),
        stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
        detached: true,
      });

      // If the server prints errors to stderr (other than deprecation warnings), stop everything.
      tempServer.stderr.on('data', (data) => {
        const text = data.toString();
        if (text.indexOf('DeprecationWarning') >= 0) return console.log(text);
        console.error('[Workflow Start Error]', text);
        try {
          tempServer.kill();
        } catch (e) {
          // ignore
        }
        process.exitCode = 1;
      });

      tempServer.stdout.on('data', (chunk) => {
        // No startup errors — stop the temp server and start a detached server (silent).
        try {
          tempServer.kill();
        } catch (e) {
          // ignore
        }
        // start final detached server using ignored stdio so it won't hang
        startDetachedServer({ foreground: false });
      });

      try {
        tempServer.unref();
        if (typeof tempServer.disconnect === 'function') tempServer.disconnect();
      } catch (e) {
        // ignore
      }
      break;
    }

    // If there are more commands, the switch will handle them here.
  } // end switch
} // end for

process.exitCode = process.exitCode || 0;
