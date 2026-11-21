'use strict';

const RoadMap = (() => {
  const TILE = 256;
  const MAX_LAT = 85.05112878;

  function project(latitude, longitude) {
    const radians = Math.max(-MAX_LAT, Math.min(MAX_LAT, latitude)) * Math.PI / 180;
    return {x:(longitude + 180) / 360, y:(1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2};
  }

  function fit(points, width, height) {
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const scale = Math.min(Math.max(width - 90, 70) / (x1 - x0), Math.max(height - 90, 70) / (y1 - y0));
    return {center:{x:(x0 + x1) / 2, y:(y0 + y1) / 2}, zoom:Math.max(3, Math.min(19, Math.floor(Math.log2(scale / TILE))))};
  }

  function create(host, onSelect) {
    const layer = (tag, className) => Object.assign(document.createElement(tag), {className});
    const tiles = layer('div', 'road-map-tiles');
    const markers = layer('div', 'road-map-markers');
    const tools = layer('div', 'road-map-tools');
    const credit = layer('a', 'road-map-credit');
    credit.href = 'https://www.openstreetmap.org/copyright';
    credit.textContent = '© OpenStreetMap contributors';
    credit.target = '_blank';
    credit.rel = 'noopener noreferrer';
    const message = layer('p', 'road-map-message');
    const route = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    route.classList.add('road-map-route');
    route.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS(route.namespaceURI, 'polyline');
    route.append(line);
    host.replaceChildren(tiles, route, markers, tools, credit, message);
    let records = [], routePoints = [], center, zoom = 17, selected, needsFit = true, frame = 0, drag;
    const images = new Map();

    function schedule() {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); });
    }

    function draw() {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      if (!records.length && !routePoints.length) {
        tiles.replaceChildren();
        images.clear();
        line.removeAttribute('points');
        message.textContent = '위치가 기록된 촬영점이 없습니다.';
        message.hidden = false;
        return;
      }
      if (needsFit) {
        ({center, zoom} = fit([...routePoints, ...records], w, h));
        needsFit = false;
      }
      const tilesAcross = 2 ** zoom, world = TILE * tilesAcross;
      const left = center.x * world - w / 2, top = center.y * world - h / 2;
      const visible = new Set();
      for (let x = Math.floor(left / TILE); x <= Math.floor((left + w) / TILE); x++) {
        for (let y = Math.floor(top / TILE); y <= Math.floor((top + h) / TILE); y++) {
          if (y < 0 || y >= tilesAcross) continue;
          const key = `${zoom}/${x}/${y}`;
          visible.add(key);
          let image = images.get(key);
          if (!image) {
            image = document.createElement('img');
            image.alt = '';
            image.draggable = false;
            image.decoding = 'async';
            image.referrerPolicy = 'strict-origin-when-cross-origin';
            image.onload = () => { image.dataset.state = 'ready'; updateNotice(); };
            image.onerror = () => { image.dataset.state = 'failed'; updateNotice(); };
            const tileX = ((x % tilesAcross) + tilesAcross) % tilesAcross;
            image.src = `https://tile.openstreetmap.org/${zoom}/${tileX}/${y}.png`;
            images.set(key, image);
            tiles.append(image);
          }
          image.style.left = `${x * TILE - left}px`;
          image.style.top = `${y * TILE - top}px`;
        }
      }
      for (const [key, image] of images) {
        if (!visible.has(key)) { image.remove(); images.delete(key); }
      }
      for (const record of records) {
        const x = record.x * world - left, y = record.y * world - top;
        record.button.style.left = x + 'px';
        record.button.style.top = y + 'px';
        record.button.hidden = x < 0 || x > w || y < 0 || y > h;
      }
      const outline = routePoints.length ? routePoints : records;
      line.setAttribute('points', outline.map(point => `${point.x * world - left},${point.y * world - top}`).join(' '));
      updateNotice();
    }

    function updateNotice() {
      const failed = [...images.values()].some(image => image.dataset.state === 'failed');
      message.textContent = '배경 지도를 불러오지 못했습니다. 촬영점과 사진은 계속 볼 수 있습니다.';
      message.hidden = !failed;
    }

    function control(label, text, action) {
      const button = layer('button', 'secondary');
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.textContent = text;
      button.onclick = action;
      tools.append(button);
    }

    function zoomBy(delta) {
      if (!records.length && !routePoints.length) return;
      zoom = Math.max(3, Math.min(19, zoom + delta));
      schedule();
    }
    control('지도 확대', '+', () => zoomBy(1));
    control('지도 축소', '−', () => zoomBy(-1));
    control('선택한 구간에 맞추기', '맞춤', () => { needsFit = true; schedule(); });

    tiles.onpointerdown = event => {
      if (event.button !== 0 || !center) return;
      drag = {x:event.clientX, y:event.clientY, center, id:event.pointerId};
      tiles.setPointerCapture(event.pointerId);
    };
    tiles.onpointermove = event => {
      if (drag?.id !== event.pointerId) return;
      const world = TILE * 2 ** zoom;
      center = {x:drag.center.x - (event.clientX - drag.x) / world,
                y:Math.max(0, Math.min(1, drag.center.y - (event.clientY - drag.y) / world))};
      schedule();
    };
    tiles.onpointerup = tiles.onpointercancel = () => { drag = null; };
    new ResizeObserver(schedule).observe(host);

    function select(id) {
      selected = id;
      for (const record of records) record.button.setAttribute('aria-pressed', String(record.id === selected));
    }

    return {
      setPhotos(photos, vertices = []) {
        routePoints = vertices.filter(point => Number.isFinite(point?.lat) && Number.isFinite(point?.lon))
          .map(point => project(point.lat, point.lon));
        markers.replaceChildren();
        records = photos.flatMap((photo, index) => {
          const {latitude, longitude} = photo.location || {};
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
          const button = layer('button', 'road-map-pin');
          button.type = 'button';
          const number = Number.isInteger(photo.sequence) && photo.sequence > 0 ? photo.sequence : index + 1;
          button.textContent = String(number);
          button.setAttribute('aria-label', `${number}번 촬영 사진`);
          button.onclick = () => onSelect(photo.id);
          markers.append(button);
          return [{...project(latitude, longitude), id:photo.id, button}];
        });
        select(selected);
        needsFit = true;
        schedule();
      },
      select,
    };
  }
  return {create, project, fit};
})();
