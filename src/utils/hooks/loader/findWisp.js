export async function fetchW() {
  let text = await fetch('https://cdn.jsdelivr.net/gh/rewz099/j-lib@main/readme.bam').then((res) =>
    res.text(),
  );
  let arr = text.split(',').map((url) => 'wss://' + url.trim() + '/wisp/');
  let settled = false;
  let c = arr.length;
  let cur = 0;

  return new Promise((resolve) => {
    for (const url of arr) {
      let ws = new WebSocket(url);
      ws.onopen = () => {
        settled = true;
        ws.close();
        resolve(url);
      };
      ws.onerror = () => {
        ws.close();
        cur++;
        if (cur == c) {
          settled = true;
          resolve(null);
        }
      };
    }

    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, 10000);
  });
}

// var url = await fetchW().then((r) => r);
// if (url == null) console.error('no sockets connected');
// else console.log(url);
