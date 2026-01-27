import { useEffect } from 'react';
import { BareMuxConnection } from '@mercuryworkshop/bare-mux';
import { useOptions } from '/src/utils/optionsContext';
import { fetchW as returnWServer } from './findWisp';
import store from './useLoaderStore';

export default function useReg() {
  const { options } = useOptions();
  const ws = `${location.protocol == 'http:' ? 'ws:' : 'wss:'}//${location.host}/wisp/`;
  const sws = [{ path: '/uv/sw.js' }, { path: '/s_sw.js', scope: '/scramjet/' }];
  const setWispStatus = store((s) => s.setWispStatus);

  useEffect(() => {
    const init = async () => {
      if (!window.scr) {
        const script = document.createElement('script');
        script.src = '/scram/scramjet.all.js';
        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }

      const { ScramjetController } = $scramjetLoadController();

      window.scr = new ScramjetController({
        files: {
          wasm: '/scram/scramjet.wasm.wasm',
          all: '/scram/scramjet.all.js',
          sync: '/scram/scramjet.sync.js',
        },
        flags: { rewriterLogs: false, scramitize: false, cleanErrors: true, sourcemaps: true },
      });

      window.scr.init();

      for (const sw of sws) {
        try {
          await navigator.serviceWorker.register(
            sw.path,
            sw.scope ? { scope: sw.scope } : undefined,
          );
        } catch (err) {
          console.warn(`SW reg err (${sw.path}):`, err);
        }
      }

      const connection = new BareMuxConnection('/baremux/worker.js');
      isStaticBuild && setWispStatus('init');
      let socket = isStaticBuild ? await returnWServer() : null;
      isStaticBuild && (!socket ? setWispStatus(false) : setWispStatus(true));

      await connection.setTransport('/libcurl/index.mjs', [
        {
          wisp:
            options.wServer != null && options.wServer !== ''
              ? options.wServer
              : isStaticBuild
                ? socket
                : ws,
        },
      ]);
    };

    init();
  }, [options.wServer]);
}
