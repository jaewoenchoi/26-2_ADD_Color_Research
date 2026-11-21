'use strict';

(() => {
  const names = ['배경·미분류', '어닝', '발코니', '담장', '출입문', '보도', '차도',
    '지붕', '차양·셔터', '간판', '하늘', '가로시설', '식물', '벽', '창문'];
  const ids = names.map((_, id) => id);
  const researchGroups = [
    ['벽', [13]], ['창문', [14]], ['문', [4]], ['간판', [9]], ['지붕', [7]],
    ['식물', [12]], ['하늘', [10]], ['바닥', [5, 6]], ['차량', []], ['사람', []], ['광고', []],
  ];
  const activeStates = ['queued', 'running'];
  const phaseElements = ['capturePhase', 'segmentPhase', 'roadPhase', 'facadePhase'];
  let job, activeRun, zipName, phase = 1, loading = false, available = false, pollTimer;
  let roadMap, roadMapKey, mapPhotoId, roadPhotoView = 'source', selectedColor;
  let roadPhotoRevision = 0, libraryFacadeMode, fromHistory = false;
  let photoRevision = 0, roadRevision = 0, roadReport, pointsReport;
  const cache = new Map(), facadeCache = new Map();
  let facadePhotoId, facadeListKey, facadeRevision = 0;
  let facadeView = 'overview', facadeSequence, morphRequest = 0, morphPosition = 0, morphSaving = false;
  const morphStepMs = 1250;
  const photoNumber = (photo, index) => Number.isInteger(photo.sequence) && photo.sequence > 0 ? photo.sequence : index + 1;

  function option(text, value) {
    const node = new Option(text, value);
    return node;
  }

  function choices(node, options) {
    const previous = node.value;
    node.replaceChildren(...options.map(([text, value]) => option(text, value)));
    if ([...node.options].some(item => item.value === previous)) node.value = previous;
  }

  async function enter(next, facadeMode) {
    if (captureBusy()) {
      toast('사진 수집이나 미리보기가 끝난 뒤 이동하세요.');
      return;
    }
    if (next === 2 && !activeRun && !zipName && !job) return;
    if (next === 3 && !canViewRoad()) return;
    const changed = phase !== next;
    if (phase === 4 && next !== 4) stopMorph();
    if (phase === 3 && next === 4 && mapPhotoId) facadePhotoId = mapPhotoId;
    phase = next;
    phaseElements.forEach((id, index) => {
      const current = index + 1 === phase;
      $(id).hidden = !current;
      $(id).classList.toggle('is-entering', current && changed);
    });
    document.querySelectorAll('[data-recap]').forEach(button => {
      button.hidden = +button.dataset.recap >= phase;
    });
    document.querySelectorAll('[data-phase]').forEach(button => {
      const number = +button.dataset.phase;
      if (number === phase) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    buttons();
    window.scrollTo(0, 0);
    $(['captureTitle', 'segmentTitle', 'roadTitle', 'facadeTitle'][phase - 1]).focus({preventScroll:true});
    if (phase === 2 && job?.ready) await renderPhoto();
    if (phase === 3) await renderRoad(changed);
    if (phase === 4) {
      const hasResults = canViewRoad();
      $('facadeContent').hidden = !hasResults;
      $('facadeEmpty').hidden = hasResults;
      if (hasResults) await openFacade(facadeMode);
      else {
        $('facadeSubtitle').textContent = '';
        $('saveFacade').hidden = true;
      }
    }
  }

  function canViewRoad() {
    return Boolean(job?.ready && !activeStates.includes(job.state) && !loading);
  }

  function buttons() {
    const busy = loading || activeStates.includes(job?.state);
    $('analyzeRun').hidden = !activeRun || Boolean(job?.ready);
    $('analyzeRun').disabled = busy || !available || !activeRun;
    if (activeRun) $('analyzeRun').textContent = `사진 ${activeRun.photos.length}장 분석 시작`;
    $('loadCapture').disabled = busy || !$('captureRuns').value;
    $('analyzeArchive').disabled = busy || !available || !$('captureArchive').files.length;
    $('loadAnalysis').disabled = busy || !$('analysisHistory').value;
    $('toRoad').disabled = $('toFacade').disabled = !canViewRoad();
    $('openSavedFacade').disabled = busy;
    const saved = activeRun?.photos.length ?? job?.total;
    $('captureRecap').textContent = saved ? saved + '장' : '';
    $('analysisRecap').textContent = job?.ready ? job.ready + '장 분석' : '';
    document.querySelectorAll('[data-phase]').forEach(button => {
      const number = +button.dataset.phase;
      button.disabled = number === 2 ? !(activeRun || zipName || job) :
        number === 3 && !canViewRoad() || number === 4 && busy;
    });
  }

  async function useSavedAnalysis(next, target, facadeMode) {
    activeRun = zipName = null;
    fromHistory = true;
    $('segmentSubtitle').textContent = next.name + ' · 사진 ' + next.total + '장';
    updateJob(next);
    if ($('library').open) $('library').close();
    await enter(target, facadeMode);
  }

  async function refreshSources() {
    const [runs, history] = await Promise.all([api('/api/history'), api('/api/analysis/history')]);
    $('libraryStatus').textContent = '';
    choices($('captureRuns'), runs.filter(run => run.saved && run.status !== 'running')
      .map(run => [`${run.folders.join(' · ') || run.label} · ${run.saved}장`, run.run_id]));
    if (S.run?.photos.length && [...$('captureRuns').options].some(item => item.value === S.run.run_id)) {
      $('captureRuns').value = S.run.run_id;
    }
    const analyses = libraryFacadeMode ? history.filter(item => item.ready && ['ready', 'partial'].includes(item.state)) : history;
    if (libraryFacadeMode && !analyses.length) $('libraryStatus').textContent = '저장한 분석 결과가 없습니다.';
    choices($('analysisHistory'), analyses.map(item => [`${item.name} · ${item.ready}/${item.total}장`, item.id]));
    buttons();
  }

  function applyModelInfo(info) {
    available = info.dependencies;
    $('modelState').textContent = available
      ? ''
      : '분석 환경을 열지 못했습니다. ZIP 전체를 압축 해제한 폴더에서 색채연구.exe를 실행하세요.';
    $('modelState').title = info.dependency_error || '';
  }

  function reportError(error) {
    if ($('library').open) $('libraryStatus').textContent = readable(error);
    else if (phase === 2) $('analysisState').textContent = readable(error);
    else toast(readable(error));
  }
  const jobUrl = id => '/api/analysis/' + id;
  const asset = (id, photoId, file) => `${jobUrl(id)}/${encodeURIComponent(photoId)}/${file}`;

  function resetJob() {
    clearTimeout(pollTimer);
    job = null;
    fromHistory = false;
    cache.clear();
    photoRevision++;
    $('analysisProgress').hidden = $('analysisErrors').hidden = $('photoInspector').hidden = true;
  }

  async function useRun(run) {
    if (!run?.photos.length) return;
    if (loading || activeStates.includes(job?.state)) {
      toast('진행 중인 분석이 끝난 뒤 다른 수집 자료를 여세요.');
      return;
    }
    const same = activeRun?.run_id === run.run_id && activeRun.photos.length === run.photos.length;
    if (!same) {
      resetJob();
      activeRun = run;
      zipName = null;
      const roads = Object.keys(run.road_folders);
      const label = run.capture_folder || (roads.length ? roads.join(' · ') : run.label || '수집한 경로');
      $('segmentTitle').textContent = '사진 분석';
      $('segmentSubtitle').textContent = `${label} · 사진 ${run.photos.length}장` +
        (run.samples ? ` 저장 / ${run.samples.length}곳 계획` : '');
      $('analysisState').textContent = '분석 대기';
      $('captureCover').src = photoPath(run.photos[0].file_path);
      $('analysisCover').hidden = false;
    }
    $('library').close();
    await enter(2);
    if (available) return;
    $('modelState').textContent = '모델 준비 중…';
    try {
      applyModelInfo(await api('/api/analysis/info'));
    } catch (error) {
      $('modelState').textContent = readable(error);
    } finally {
      buttons();
    }
  }

  async function start(request) {
    if (loading || activeStates.includes(job?.state)) return;
    loading = true;
    buttons();
    $('analysisState').textContent = '사진 확인 중…';
    try {
      updateJob(await request());
    } catch (error) {
      reportError(error);
    } finally {
      loading = false;
      buttons();
    }
  }

  async function upload() {
    const file = $('captureArchive').files[0];
    const response = await fetch('/api/analysis/import', {
      method: 'POST', headers: {'Content-Type': 'application/zip', 'X-Capture-Token': S.token}, body: file,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  }

  async function openJob(id) {
    if (id) updateJob(await api(jobUrl(id)));
  }

  function updateJob(next) {
    clearTimeout(pollTimer);
    const newJob = job?.id !== next.id;
    const changed = newJob || job?.ready !== next.ready;
    job = {...next, photos:[...next.photos].sort((a, b) =>
      (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER))};
    const state = {queued:'분석 대기', running:'분석 중', ready:'분석 완료', partial:'일부 완료', failed:'분석 중단'};
    $('analysisState').textContent = `${state[job.state]} · ${job.ready}/${job.total}장`;
    const progress = $('analysisProgress');
    progress.hidden = !activeStates.includes(job.state);
    progress.max = job.total;
    progress.value = job.done;
    const errors = [...(job.error ? [job.error] : []), ...job.failures.map(item => `${item.id} · ${item.message}`)];
    $('analysisErrors').replaceChildren(...errors.map(message => element('li', '', message)));
    $('analysisErrors').hidden = !errors.length;
    $('photoInspector').hidden = !job.ready;
    $('analysisCover').hidden = Boolean(job.ready || !activeRun);
    if (job.ready && !activeStates.includes(job.state)) {
      $('segmentTitle').textContent = '사진 분석 결과';
    } else {
      $('segmentTitle').textContent = '사진 분석';
    }
    if (changed) {
      if (newJob) {
        cache.clear();
        facadeCache.clear();
      }
      choices($('analyzedPhoto'), job.photos.map((photo, index) => [`${photoNumber(photo, index)}번 촬영 · ${index + 1}/${job.photos.length}`, photo.id]));
      if (job.ready && phase === 2) renderPhoto().catch(reportError);
      if (phase === 3) renderRoad();
    }
    buttons();
    if (activeStates.includes(job.state)) {
      pollTimer = setTimeout(() => openJob(next.id).catch(error => {
        reportError(error);
        pollTimer = setTimeout(() => openJob(next.id).catch(reportError), 3000);
      }), 1200);
    } else if (![...$('analysisHistory').options].some(item => item.value === job.id)) {
      $('analysisHistory').add(option(`${job.name} · ${job.ready}/${job.total}장`, job.id), 0);
      $('analysisHistory').value = job.id;
      buttons();
    }
  }

  function photoData(jobId, photo) {
    const url = asset(jobId, photo.id, 'analysis.json');
    if (!cache.has(url)) cache.set(url, api(url).catch(error => {
      cache.delete(url);
      throw error;
    }));
    return cache.get(url);
  }

  function merge(rows, selected) {
    const aggregate = {pixels: 0, lightness: 0, saturation: 0, bins: new Map()};
    for (const row of rows) {
      for (const id of selected) {
        const cls = row.classes[id];
        aggregate.pixels += cls.pixels;
        aggregate.lightness += cls.lightness_sum;
        aggregate.saturation += cls.saturation_sum;
        for (const [id, count, r, g, b] of cls.bins) {
          const bin = aggregate.bins.get(id) || [0, 0, 0, 0];
          bin[0] += count;
          bin[1] += r;
          bin[2] += g;
          bin[3] += b;
          aggregate.bins.set(id, bin);
        }
      }
    }
    return aggregate;
  }

  const hex = rgb => '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
  const fraction = (count, total) => total ? count / total : 0;
  const pct = (count, total) => (fraction(count, total) * 100).toFixed(1) + '%';

  function palette(data) {
    const bins = [...data.bins.values()].sort((a, b) => b[0] - a[0]);
    const rest = bins.splice(10);
    const tiles = bins.map(([count, ...rgb]) => ({count, color: hex(rgb.map(n => Math.round(n / count)))}));
    if (rest.length) tiles.push({count: rest.reduce((n, bin) => n + bin[0], 0), color: '#eceef1', label: '그 외 색'});
    return tiles.map(tile => ({...tile, share: fraction(tile.count, data.pixels)}));
  }

  function scopeIds(scope) {
    return scope === 'scene' ? ids : scope === 'all' ? ids.slice(1) : [+scope];
  }

  function scopeName(scope) {
    return scope === 'scene' ? '전체 장면' : scope === 'all' ? '분류된 요소 전체' : names[+scope];
  }

  // Split weighted RGB cells into representative colors without dropping the remaining pixels.
  function groupedPalette(data, limit = 10) {
    if (!data.pixels) return [];
    const cells = [...data.bins].map(([id, [count, r, g, b]]) => ({
      id, count, sums:[r, g, b], rgb:[r / count, g / count, b / count],
    }));
    function measure(items) {
      const spans = [0, 1, 2].map(channel => {
        const values = items.map(item => item.rgb[channel]);
        return Math.max(...values) - Math.min(...values);
      });
      const axis = spans.indexOf(Math.max(...spans));
      const count = items.reduce((sum, item) => sum + item.count, 0);
      return {items, count, axis, priority:spans[axis] * Math.sqrt(count)};
    }
    const groups = [measure(cells)];
    while (groups.length < limit) {
      let widest = -1;
      groups.forEach((group, index) => {
        if (group.items.length > 1 && (widest === -1 || group.priority > groups[widest].priority)) widest = index;
      });
      if (widest < 0) break;
      const {items, count, axis} = groups[widest];
      items.sort((a, b) => a.rgb[axis] - b.rgb[axis] || a.id - b.id);
      let split = 1, weight = items[0].count;
      while (split < items.length - 1 && weight + items[split].count / 2 < count / 2) {
        weight += items[split++].count;
      }
      groups.splice(widest, 1, measure(items.slice(0, split)), measure(items.slice(split)));
    }
    return groups.sort((a, b) => b.count - a.count).map(({items, count}) => ({
      count, share:fraction(count, data.pixels),
      color:hex([0, 1, 2].map(channel => Math.round(items.reduce((sum, item) => sum + item.sums[channel], 0) / count))),
      bins:items.map(item => item.id).sort((a, b) => a - b),
    }));
  }

  function swatches(node, tiles, onChoose) {
    const total = tiles.reduce((sum, tile) => sum + tile.count, 0);
    node.replaceChildren(...tiles.map(tile => {
      const chip = element(onChoose ? 'button' : 'span', 'color-chip');
      if (onChoose) {
        chip.type = 'button';
        chip.setAttribute('aria-pressed', 'false');
        chip.onclick = () => onChoose(tile, chip);
      }
      const color = element('i');
      color.style.backgroundColor = tile.color;
      chip.append(color, element('b', '', tile.color), element('small', '', pct(tile.count, total)));
      return chip;
    }));
  }

  function contrastingInk(r, g, b) {
    const linear = value => value <= 10.31475 ? value / 3294.6 : ((value / 255 + .055) / 1.055) ** 2.4;
    return .2126 * linear(r) + .7152 * linear(g) + .0722 * linear(b) > .179 ? '#000' : '#fff';
  }

  function treemap(node, tiles, denominator, onChoose) {
    node.replaceChildren();
    if (!tiles.length) {
      node.append(element('p', 'hint', '표시할 픽셀이 없습니다.'));
      return;
    }
    function draw(items, x, y, w, h) {
      if (items.length === 1) {
        const item = items[0];
        const label = `${item.label || item.color} · ${pct(item.count, denominator)}`;
        const tile = element(onChoose ? 'button' : 'div', 'research-tile');
        const caption = element('span', 'tile-label');
        caption.append(element('strong', '', pct(item.count, denominator)), element('small', '', item.label || item.color));
        tile.append(caption);
        tile.title = label;
        const rgb = item.color.slice(1).match(/../g).map(value => parseInt(value, 16));
        tile.style.color = contrastingInk(...rgb);
        if (onChoose) {
          tile.type = 'button';
          tile.setAttribute('aria-label', label);
          tile.setAttribute('aria-pressed', 'false');
          tile.onclick = () => onChoose(item);
        }
        Object.assign(tile.style, {
          left: x + '%', top: y + '%', width: w + '%', height: h + '%', backgroundColor: item.color,
        });
        node.append(tile);
        return;
      }
      const total = items.reduce((sum, item) => sum + item.count, 0);
      let sum = items[0].count, split = 1;
      while (split < items.length - 1 && sum + items[split].count / 2 < total / 2) sum += items[split++].count;
      const share = sum / total;
      if (w * node.clientWidth >= h * node.clientHeight) {
        draw(items.slice(0, split), x, y, w * share, h);
        draw(items.slice(split), x + w * share, y, w * (1 - share), h);
      } else {
        draw(items.slice(0, split), x, y, w, h * share);
        draw(items.slice(split), x, y + h * share, w, h * (1 - share));
      }
    }
    draw(tiles, 0, 0, 100, 100);
  }

  function metrics(value, total) {
    if (!value.pixels) return '이 요소가 사진에 없습니다.';
    return `사진의 ${pct(value.pixels, total)} · 밝기 ${(value.lightness / value.pixels).toFixed(1)} L* · 채도 ${pct(value.saturation, value.pixels)}`;
  }

  async function renderPhoto() {
    const revision = ++photoRevision;
    const photo = job?.photos.find(item => item.id === $('analyzedPhoto').value);
    if (!photo) return;
    const index = $('analyzedPhoto').selectedIndex;
    $('prevPhoto').disabled = index <= 0;
    $('nextPhoto').disabled = index >= job.photos.length - 1;
    const id = +$('analyzedClass').value;
    const jobId = job.id;
    const url = file => asset(jobId, photo.id, file);
    $('photoInfo').textContent = `${photo.location.latitude.toFixed(6)}, ${photo.location.longitude.toFixed(6)}` +
      (photo.location.heading_deg != null ? ` · 촬영 방향 ${Number(photo.location.heading_deg).toFixed(1)}°` : '') +
      (photo.overlays ? ' · 거리뷰 화면 표시가 남아 있을 수 있음' : '');
    const view = $('photoView').value;
    $('photoMetrics').textContent = '색 분포 계산 중…';
    $('photoPalette').replaceChildren();
    $('maskLinks').replaceChildren();
    const [result, manifest] = await Promise.all([photoData(jobId, photo), api(url('manifest.json'))]);
    if (revision !== photoRevision) return;
    const cls = manifest.classes.find(item => item.id === id);
    $('analysisPreview').src = url({preview:'preview_overlay.jpg', source:'source_rgb.png',
      mask:cls.mask_path, clip:cls.clip_path}[view]);
    const aggregate = merge([result], [id]);
    $('photoMetrics').textContent = names[id] + ' · ' + metrics(aggregate, result.total_pixels);
    treemap($('photoPalette'), palette(aggregate), aggregate.pixels);
    for (const [label, file] of [['클래스 ID 지도', 'label_map.png'], ['마스크 PNG', cls.mask_path],
      ['클립 PNG', cls.clip_path], ['위치·분류 기록', 'manifest.json']]) {
      const link = element('a', '', label);
      link.href = url(file);
      link.download = file.split('/').pop();
      $('maskLinks').append(link);
    }
  }

  function drawPhotoList(node, photos, onSelect) {
    node.replaceChildren(...photos.map((photo, index) => {
      const button = element('button', 'road-thumb');
      button.type = 'button';
      button.dataset.photoId = photo.id;
      const image = element('img');
      image.src = asset(job.id, photo.id, 'preview_overlay.jpg');
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      button.append(image, element('span', '', photoNumber(photo, index) + '번 사진'));
      button.onclick = () => onSelect(photo.id);
      return button;
    }));
  }

  function markPhoto(node, id) {
    for (const button of node.children) {
      button.setAttribute('aria-pressed', String(button.dataset.photoId === id));
    }
  }

  function drawMap(photos, vertices, key, handoff) {
    if (roadMapKey === key) {
      if (handoff && handoff !== mapPhotoId && photos.some(photo => photo.id === handoff)) selectRoadPhoto(handoff);
      return;
    }
    roadMapKey = key;
    if (!roadMap) roadMap = RoadMap.create($('areaMap'), selectRoadPhoto);
    roadMap.setPhotos(photos, vertices);
    drawPhotoList($('roadPhotoList'), photos, selectRoadPhoto);
    selectRoadPhoto(photos.find(photo => photo.id === handoff)?.id || photos[0]?.id);
  }

  function renderRoadPhotoImage() {
    if (!mapPhotoId) return;
    const scope = $('roadPhotoClass').value;
    const base = file => asset(job.id, mapPhotoId, file);
    let url = base('source_rgb.png');
    if (roadPhotoView !== 'source' && (scope !== 'scene' || selectedColor)) {
      const query = new URLSearchParams({class:scope, mode:roadPhotoView});
      if (selectedColor) query.set('bins', selectedColor.bins.join(','));
      url = base('color-view.png') + '?' + query;
    }
    $('mapPhotoImage').src = url;
    $('mapPhotoImage').parentElement.classList.toggle('is-isolated', roadPhotoView === 'isolate' && url.includes('?'));
    document.querySelectorAll('[data-road-view]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.roadView === roadPhotoView));
    });
    $('clearRoadColor').hidden = !selectedColor;
  }

  async function selectRoadPhoto(id) {
    const photos = job?.photos || [];
    const index = photos.findIndex(photo => photo.id === id);
    const photo = photos[index];
    mapPhotoId = photo?.id;
    $('mapPhoto').hidden = $('roadPhotoColors').hidden = !photo;
    if (!photo) return;
    roadMap.select(photo.id);
    markPhoto($('roadPhotoList'), photo.id);
    $('roadPhotoTitle').textContent = `${photoNumber(photo, index)}번 촬영 · ${index + 1}/${photos.length}장`;
    const {latitude, longitude} = photo.location || {};
    $('mapPoint').textContent = Number.isFinite(latitude) && Number.isFinite(longitude)
      ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}` : '촬영 위치 없음';
    if (photo.overlays) $('mapPoint').textContent += ' · 거리뷰 화면 표시 포함';
    await renderRoadPhoto(photo);
  }

  async function renderRoadPhoto(photo) {
    const revision = ++roadPhotoRevision;
    selectedColor = null;
    renderRoadPhotoImage();
    $('roadPhotoMetrics').textContent = '색 분포 계산 중…';
    $('roadPhotoPalette').replaceChildren();
    $('roadPhotoSwatches').replaceChildren();
    try {
      const result = await photoData(job.id, photo);
      if (revision !== roadPhotoRevision || mapPhotoId !== photo.id) return;
      const scope = $('roadPhotoClass').value;
      const aggregate = merge([result], scopeIds(scope));
      const tiles = groupedPalette(aggregate);
      $('roadPhotoMetrics').textContent = scopeName(scope) + ' · ' + metrics(aggregate, result.total_pixels);
      $('roadPhotoColorTitle').textContent = photoNumber(photo, job.photos.indexOf(photo)) + '번 사진의 색 분포';
      const choose = tile => {
        selectedColor = selectedColor === tile ? null : tile;
        if (selectedColor && roadPhotoView === 'source') roadPhotoView = 'overlay';
        markRoadColor(tiles.indexOf(selectedColor));
        renderRoadPhotoImage();
      };
      treemap($('roadPhotoPalette'), tiles, aggregate.pixels, choose);
      swatches($('roadPhotoSwatches'), tiles, choose);
    } catch (error) {
      if (revision === roadPhotoRevision) $('roadPhotoMetrics').textContent = readable(error);
    }
  }

  function markRoadColor(index) {
    for (const id of ['roadPhotoPalette', 'roadPhotoSwatches']) {
      [...$(id).children].forEach((item, position) => item.setAttribute('aria-pressed', String(index === position)));
    }
  }

  async function renderRoad(preferPhoto = false) {
    const revision = ++roadRevision;
    roadReport = pointsReport = null;
    $('saveRoad').disabled = $('savePoints').disabled = true;
    if ($('roadResult').dataset.jobId !== job?.id) $('roadResult').hidden = true;
    const photos = job?.photos || [];
    const capture = job?.capture_scope;
    const routeName = capture?.label?.trim() || '선택한 구간';
    const vertices = capture?.vertices || [];
    const scope = $('roadClass').value;
    const selected = scopeIds(scope);
    drawMap(photos, vertices, JSON.stringify([job?.id, vertices, ...photos.map(photo => photo.id)]),
      preferPhoto ? $('analyzedPhoto').value : undefined);
    $('roadTitle').textContent = `${routeName}의 색채`;
    $('roadStatus').textContent = photos.length ? '팔레트 계산 중…' : '먼저 2단계에서 사진을 분할하세요.';
    if (!photos.length) return;
    try {
      const rows = [], jobId = job.id;
      for (const photo of photos) {
        if (revision !== roadRevision) return;
        rows.push(await photoData(jobId, photo));
      }
      if (revision !== roadRevision) return;
      const total = rows.reduce((sum, row) => sum + row.total_pixels, 0);
      const aggregate = merge(rows, selected);
      const modelClasses = ids.map(id => {
        const data = merge(rows, [id]);
        return {id, name: names[id], pixels: data.pixels, area_share: fraction(data.pixels, total),
          mean_lstar: data.pixels ? data.lightness / data.pixels : null,
          mean_hsv_saturation: data.pixels ? data.saturation / data.pixels : null,
          palette: palette(data)};
      });
      const shownColors = groupedPalette(aggregate);
      roadReport = {road:routeName, capture_scope:capture || null, model:'baseline', quality_status:'prototype_requires_review',
        scope: 'photograph_pixels_not_physical_area', photo_ids: photos.map(photo => photo.id),
        total_pixels: total, selected_model_ids: selected, selected_pixels: aggregate.pixels,
        selected_area_share: fraction(aggregate.pixels, total),
        mean_lstar: aggregate.pixels ? aggregate.lightness / aggregate.pixels : null,
        mean_hsv_saturation: aggregate.pixels ? aggregate.saturation / aggregate.pixels : null,
        palette: shownColors.map(({count, share, color}) => ({count, share, color})), model_classes: modelClasses,
        research_groups: researchGroups.map(([name, model_ids]) => ({name, model_ids,
          status: model_ids.length ? 'mapped' : 'unsupported',
          pixels: model_ids.length ? model_ids.reduce((n, id) => n + modelClasses[id].pixels, 0) : null})),
        model_only_ids: [1, 2, 3, 8, 11],
      };
      pointsReport = {type:'FeatureCollection', features: photos.map(photo => ({
        type:'Feature', id:photo.id,
        geometry:{type:'Point', coordinates:[photo.location.longitude, photo.location.latitude]},
        properties:{road:photo.road, capture_run_id:capture?.run_id ?? null, photo_id:photo.id, sequence:photo.sequence, heading_deg:photo.location.heading_deg,
          total_pixels:photo.pixels, class_pixel_counts:photo.counts,
          selected_area_share:fraction(selected.reduce((n, id) => n + photo.counts[id], 0), photo.pixels)},
      }))};
      $('roadStatus').textContent = photos.length + '장 분석' +
        (job.state === 'partial' ? ' · ' + job.failures.length + '장 실패' : '');
      $('roadResult').dataset.jobId = job.id;
      $('roadResult').hidden = false;
      $('roadMetrics').textContent = `${scopeName(scope)} · ${metrics(aggregate, total)}`;
      treemap($('roadPalette'), shownColors, aggregate.pixels);
      swatches($('roadSwatches'), shownColors);
      $('saveRoad').disabled = $('savePoints').disabled = false;
    } catch (error) {
      if (revision === roadRevision) $('roadStatus').textContent = readable(error);
    }
  }

  const facadeElements = [
    {id:13, label:'벽'},
    {id:7, label:'지붕'},
    {id:14, label:'창문'},
    {id:4, label:'출입문'},
    {id:9, label:'간판'},
    {id:1, label:'어닝'},
  ];

  function svgNode(tag, attributes) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  const facadeSlots = [
    {
      side:'left', start:0, end:.57, height:.93, title:'앞쪽',
      roof:[[0,.035], [.12,-.15], [.86,-.15], [1,.035]],
      window:[.64,.37,.89,.67], door:[.16,.48,.43,1],
    },
    {
      side:'left', start:.62, end:1, height:.89, title:'안쪽',
      roof:[[0,.04], [0,-.10], [.61,-.10], [.61,-.04], [1,-.04], [1,.04]],
      window:[.14,.36,.56,.74], door:[.72,.49,.90,1],
    },
    {
      side:'right', start:.62, end:1, height:.93, title:'안쪽',
      roof:[[0,.04], [0,-.07], [1,-.13], [1,.04]],
      window:[.55,.33,.88,.74], door:[.13,.52,.39,1],
    },
    {
      side:'right', start:0, end:.57, height:.88, title:'앞쪽',
      roof:[[0,.04], [0,-.10], [1,-.10], [1,.04]], slats:true,
      window:[.12,.40,.58,.77], door:[.70,.46,.89,1],
    },
  ];

  function drawFacade(regions, drawing = $('facadeDrawing'), motion = [], {transparent = false} = {}) {
    drawing.replaceChildren();
    if (!transparent) drawing.append(svgNode('rect', {width:1200, height:660, fill:'#fbfaf8'}));

    regions.forEach((palettes, index) => {
      const slot = facadeSlots[index];
      const change = motion[index];
      const opacity = id => change?.weights.get(id) ?? 1;
      const geometry = change?.geometry ?? [1, 1, 1];
      const resize = ([u0,v0,u1,v1], scale, anchored) => {
        const mid = (u0 + u1) / 2, half = (u1 - u0) * scale / 2;
        return [Math.max(0,mid-half), Math.max(.08,v1-(v1-v0)*scale), Math.min(1,mid+half),
          anchored ? 1 : v1];
      };
      const elevation = svgNode('g', {'data-house':index + 1, 'data-side':slot.side});
      drawing.append(elevation);

      // All four volumes are diagrammatic and share the same vanishing point.
      const project = (u, v) => {
        const distance = slot.start + (slot.end - slot.start) * u;
        const depth = .65 * distance / (1 - .35 * distance);
        const x = 42 + 420 * depth;
        const floor = 593 - 168 * depth;
        return [slot.side === 'left' ? x : 1200 - x, floor - (1 - v) * (505 - 326 * depth) * slot.height * geometry[0]];
      };
      const outline = (vertices, fill, attributes = {}) => svgNode('polygon', {
        points:vertices.map(([u,v]) => project(u,v).join(',')).join(' '), fill, ...attributes,
      });
      const rect = ([u0,v0,u1,v1], fill, attributes) =>
        outline([[u0,v0], [u1,v0], [u1,v1], [u0,v1]], fill, attributes);
      const rule = (group, from, to, stroke, width) => {
        const [x1,y1] = project(...from), [x2,y2] = project(...to);
        group.append(svgNode('line', {x1,y1,x2,y2,stroke,'stroke-width':width}));
      };
      const bands = (group, colors, [u0,v0,u1,v1], horizontal, alpha) => {
        let edge = 0;
        colors.forEach((tile, i) => {
          const next = i + 1 === colors.length ? 1 : edge + tile.share;
          const area = horizontal
            ? [u0, v0 + (v1 - v0) * edge, u1, v0 + (v1 - v0) * next]
            : [u0 + (u1 - u0) * edge, v0, u0 + (u1 - u0) * next, v1];
          group.append(rect(area, tile.color, {'fill-opacity':alpha}));
          edge = next;
        });
      };

      const wall = svgNode('g', {'data-element':13});
      elevation.append(wall);
      wall.append(rect([0,0,1,1], '#efede8', {stroke:'#d9d4cb','stroke-width':1.5}));
      bands(wall, palettes.get(13) || [], [0,0,1,1], true, opacity(13));

      const clipId = drawing.id + '-roof-' + (index + 1);
      const clip = svgNode('clipPath', {id:clipId});
      clip.append(outline(slot.roof, '#fff'));
      const roof = svgNode('g', {'data-element':7, 'clip-path':'url(#' + clipId + ')'});
      roof.append(outline(slot.roof, '#d7d3cc'));
      bands(roof, palettes.get(7) || [], [0,-.15,1,.04], false, opacity(7));
      if (slot.slats) {
        for (const u of [.12,.24,.36,.48,.60,.72,.84]) rule(roof, [u,-.10], [u,.04], '#27252b', 1);
      }
      elevation.append(clip, roof, outline(slot.roof, 'none', {stroke:'#827d74','stroke-width':1.4}));

      const details = [
        [9, [.20,.16,.81,.25]], [1, [.12,.28,.83,.36]],
        [14, resize(slot.window, geometry[1], false)], [4, resize(slot.door, geometry[2], true)],
      ];
      for (const [id, zone] of details) {
        const colors = palettes.get(id) || [];
        if (!colors.length && id !== 4) continue;
        const group = svgNode('g', {'data-element':id});
        if (id === 4) group.append(rect(zone, '#aaa7a2', {stroke:'#efebe3','stroke-width':2}));
        else group.setAttribute('opacity', opacity(id));
        bands(group, colors, zone, id === 4, id === 4 ? opacity(id) : 1);
        if (id === 14 || id === 4) group.append(rect(zone, 'none', {stroke:'#f3efe8','stroke-width':4}));
        if (id === 14) {
          const [u0,v0,u1,v1] = zone;
          rule(group, [u0,(v0+v1)/2], [u1,(v0+v1)/2], '#f3efe8', 2);
          if (index === 1 || index === 3) rule(group, [(u0+u1)/2,v0], [(u0+u1)/2,v1], '#f3efe8', 2);
        }
        elevation.append(group);
      }

      const [x,y] = project(.50,1);
      const label = svgNode('text', {x,y:y+27,'text-anchor':'middle',fill:'#67625b',
        'font-family':'Arial, sans-serif','font-size':15,'font-weight':600});
      label.textContent = '0' + (index + 1);
      elevation.append(label);
    });
  }


  function renderFacadePalette(palettes, index) {
    const node = element('section', 'facade-house');
    node.append(element('h4', 'facade-house-title', '0' + (index + 1) + '  ' + facadeSlots[index].title));
    let hasColors = false;
    for (const {id, label} of facadeElements) {
      const colors = palettes.get(id);
      if (!colors?.length) {
        if (id === 4 || id === 7) {
          const row = element('section', 'facade-element');
          row.append(element('h5', '', label), element('span', 'muted', '감지 안 됨'));
          node.append(row);
        }
        continue;
      }
      hasColors = true;
      const row = element('section', 'facade-element');
      const bar = element('div', 'facade-bar');
      bar.setAttribute('aria-hidden', 'true');
      for (const tile of colors) {
        const color = element('span');
        color.style.backgroundColor = tile.color;
        color.style.flexGrow = tile.share;
        bar.append(color);
      }
      const legend = element('div', 'color-swatches');
      swatches(legend, colors);
      row.append(element('h5', '', label), bar, legend);
      node.append(row);
    }
    if (!hasColors) node.append(element('p', 'hint', '분류된 입면 요소 없음'));
    return node;
  }

  function readFacadeScene(jobId, id) {
    const url = asset(jobId, id, 'facade.json');
    if (!facadeCache.has(url)) facadeCache.set(url, api(url).then(({regions}) => {
      const palettes = regions.map(classes => new Map(classes.map(({id, pixels, bins}) => [
        id, groupedPalette({pixels, bins:new Map(bins.map(([key, ...stats]) => [key, stats]))}, 4),
      ])));
      const geometry = regions.map(classes => {
        const area = new Map(classes.map(row => [row.id, row.pixels]));
        const total = classes.reduce((sum, row) => sum + row.pixels, 0);
        const share = id => fraction(area.get(id) || 0, total);
        return [.94 + .13 * share(13), .85 + .38 * Math.sqrt(share(14)), .85 + .38 * Math.sqrt(share(4))];
      });
      return {palettes, geometry};
    }).catch(async error => {
      facadeCache.delete(url);
      if (error.status === 400 || error.status === 404) {
        const info = await api('/api/info');
        if (!info.facade_palettes) throw new Error('새 폴더의 색채연구.exe를 실행해 주세요.');
      }
      throw error;
    }));
    return facadeCache.get(url);
  }

  function loadSequence(sequence) {
    if (sequence.loading) return sequence.loading;
    let index = 0;
    const worker = async () => {
      while (index < sequence.photos.length && facadeSequence === sequence) {
        const next = index++;
        if (sequence.scenes[next]) continue;
        try {
          sequence.scenes[next] = await readFacadeScene(sequence.jobId, sequence.photos[next].id);
        } catch {
          sequence.scenes[next] = null;
        }
      }
    };
    sequence.loading = Promise.all(Array.from({length:3}, worker)).finally(() => { sequence.loading = null; });
    return sequence.loading;
  }

  function newFacadeSvg(id) {
    return svgNode('svg', {id, viewBox:'0 0 1200 660', width:1200, height:660, 'aria-hidden':'true'});
  }

  async function showFacadeView(view, photoId) {
    const sequence = facadeSequence;
    if (!sequence || phase !== 4) return;
    stopMorph();
    facadeView = view;
    const panels = {overview:'facadeOverview', detail:'facadeDetail', morph:'facadeMorph'};
    for (const [name, id] of Object.entries(panels)) $(id).hidden = name !== view;
    document.querySelectorAll('[data-facade-view]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.facadeView === view));
    });
    $('saveFacade').hidden = view !== 'detail';
    if (view === 'detail') return loadFacade(photoId || facadePhotoId);
    if (view === 'overview') return renderFacadeDeck(sequence);

    $('playMorph').disabled = $('morphPosition').disabled = $('saveMorph').disabled = true;
    $('facadeMorphDrawing').setAttribute('hidden', '');
    $('facadeMorphStatus').textContent = '입면 불러오는 중…';
    await loadSequence(sequence);
    if (facadeSequence !== sequence || facadeView !== 'morph' || phase !== 4) return;
    if (!sequence.scenes.every(Boolean)) {
      $('facadeMorphStatus').textContent = '일부 입면을 열 수 없습니다. 모핑을 다시 눌러 주세요.';
      return;
    }
    const canPlay = sequence.photos.length > 1;
    $('morphPosition').max = (sequence.photos.length - 1) * 100;
    $('playMorph').disabled = $('morphPosition').disabled = !canPlay;
    $('saveMorph').disabled = !canPlay || morphSaving;
    $('facadeMorphStatus').textContent = canPlay ? '' : '사진이 2장 이상이면 모핑할 수 있습니다.';
    $('facadeMorphDrawing').removeAttribute('hidden');
    showMorphFrame(morphPosition);
  }

  function selectFacadeLayer(index, raise = false) {
    const sequence = facadeSequence;
    const photo = sequence?.photos[index];
    if (!photo) return;
    facadePhotoId = photo.id;
    const label = photoNumber(photo,index) + '번 사진';
    const slider = $('stackPosition');
    slider.value = index;
    slider.setAttribute('aria-valuetext', label);
    $('stackPositionLabel').textContent = label;
    [...$('facadeDeck').children].forEach((card, i) => {
      if (i === index) card.setAttribute('aria-current', 'true');
      else card.removeAttribute('aria-current');
      card.classList.toggle('is-raised', i === index && raise);
    });
  }

  function updateFacadeLayout() {
    const layout = $('facadeLayout').value;
    $('facadeDeck').dataset.layout = layout;
    $('facadeStackControls').hidden = layout !== 'layers';
  }

  async function renderFacadeDeck(sequence) {
    const originals = $('facadeMedia').value === 'source';
    const deck = $('facadeDeck');
    deck.dataset.media = originals ? 'source' : 'facades';
    deck.style.setProperty('--deck-columns', Math.min(7, sequence.photos.length));
    const cards = sequence.photos.map((photo, index) => {
      const button = element('button', 'facade-frame');
      button.type = 'button';
      button.dataset.photoId = photo.id;
      button.style.setProperty('--stack-position', index / Math.max(1, sequence.photos.length - 1));
      const media = element('span', 'facade-frame-media');
      if (originals) {
        const image = element('img');
        image.src = asset(sequence.jobId, photo.id, 'source_rgb.png');
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        media.append(image);
      } else {
        media.textContent = '불러오는 중…';
      }
      button.append(media, element('span', 'facade-frame-label', photoNumber(photo,index) + '번 사진'));
      button.onclick = () => showFacadeView('detail', photo.id).catch(reportError);
      return button;
    });
    deck.replaceChildren(...cards);
    $('stackPosition').max = sequence.photos.length - 1;
    $('stackPosition').disabled = sequence.photos.length < 2;
    selectFacadeLayer(Math.max(0, sequence.photos.findIndex(photo => photo.id === facadePhotoId)));
    updateFacadeLayout();
    $('facadeOverviewStatus').textContent = '';
    if (originals) return;
    await loadSequence(sequence);
    if (facadeSequence !== sequence || facadeView !== 'overview' || deck.firstChild !== cards[0]) return;
    sequence.scenes.forEach((scene,index) => {
      const media = cards[index].firstChild;
      if (!scene) {
        media.textContent = '입면 없음';
        return;
      }
      const drawing = newFacadeSvg('facade-frame-' + index);
      drawFacade(scene.palettes, drawing, [], {transparent:true});
      media.replaceChildren(drawing);
    });
    const missing = sequence.scenes.filter(scene => !scene).length;
    $('facadeOverviewStatus').textContent = missing ? missing + '장의 입면을 열 수 없습니다.' : '';
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  const rgbChannels = color => color.slice(1).match(/../g).map(value => parseInt(value, 16));

  function paintMorphFrame(scenes, position, drawing) {
    const left = Math.floor(position);
    const first = scenes[left], next = scenes[Math.min(left + 1, scenes.length - 1)];
    const part = position - left;
    const t = part * part * (3 - 2 * part);
    const motion = [];
    const palettes = first.palettes.map((region, index) => {
      const geometry = first.geometry[index].map((value, axis) => lerp(value, next.geometry[index][axis], t));
      const weights = new Map();
      motion.push({geometry, weights});
      return new Map(facadeElements.map(({id}) => {
        const a = region.get(id) || [], b = next.palettes[index].get(id) || [];
        const total = lerp(a.length ? 1 : 0, b.length ? 1 : 0, t);
        weights.set(id, total);
        if (!total) return [id, []];
        const colors = Array.from({length:Math.max(a.length, b.length)}, (_, rank) => {
          const ca = rgbChannels((a[rank] || b[rank]).color);
          const cb = rgbChannels((b[rank] || a[rank]).color);
          return {
            color: hex(ca.map((channel, axis) => Math.round(lerp(channel, cb[axis], t)))),
            share: lerp(a[rank]?.share || 0, b[rank]?.share || 0, t) / total,
          };
        }).filter(color => color.share > 0);
        return [id, colors];
      }));
    });
    drawFacade(palettes, drawing, motion);
  }

  function showMorphFrame(position) {
    const sequence = facadeSequence;
    if (!sequence?.scenes.every(Boolean)) return;
    morphPosition = Math.min(sequence.photos.length - 1, Math.max(0, position));
    paintMorphFrame(sequence.scenes, morphPosition, $('facadeMorphDrawing'));
    const left = Math.floor(morphPosition), right = Math.ceil(morphPosition);
    const leftLabel = photoNumber(sequence.photos[left], left) + '번';
    const label = right === left ? leftLabel : leftLabel + ' → ' + photoNumber(sequence.photos[right], right) + '번';
    $('morphPosition').value = Math.round(morphPosition * 100);
    $('morphPosition').setAttribute('aria-valuetext', label);
    $('morphPositionLabel').textContent = label;
  }

  function stopMorph() {
    cancelAnimationFrame(morphRequest);
    morphRequest = 0;
    $('playMorph').textContent = '재생';
  }

  function toggleMorph() {
    if (morphRequest) return stopMorph();
    const last = facadeSequence.photos.length - 1;
    const start = morphPosition >= last ? 0 : morphPosition;
    const time = performance.now();
    $('playMorph').textContent = '일시정지';
    const tick = now => {
      const position = Math.min(last, start + (now - time) / morphStepMs);
      showMorphFrame(position);
      if (position >= last) stopMorph();
      else morphRequest = requestAnimationFrame(tick);
    };
    morphRequest = requestAnimationFrame(tick);
  }

  async function paintVideoCanvas(context, drawing) {
    const markup = new XMLSerializer().serializeToString(drawing);
    const source = URL.createObjectURL(new Blob([markup], {type:'image/svg+xml;charset=utf-8'}));
    try {
      const image = new Image();
      image.src = source;
      await image.decode();
      context.drawImage(image, 0, 0, context.canvas.width, context.canvas.height);
    } finally {
      URL.revokeObjectURL(source);
    }
  }

  async function exportMorph() {
    const sequence = facadeSequence;
    if (morphSaving || sequence.photos.length < 2 || !sequence.scenes.every(Boolean)) return;
    const canvas = element('canvas');
    const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find(type =>
      window.MediaRecorder?.isTypeSupported(type));
    if (!canvas.captureStream || !mimeType) return toast('동영상 저장은 Chrome 또는 Edge에서 열어 주세요.');
    stopMorph();
    morphSaving = true;
    $('saveMorph').disabled = true;
    $('facadeMorphStatus').textContent = '동영상 만드는 중…';
    const drawing = newFacadeSvg('facadeVideoDrawing');
    const context = canvas.getContext('2d');
    canvas.width = 1200;
    canvas.height = 660;
    const fps = 24, frameMs = 1000 / fps;
    const frameCount = (sequence.scenes.length - 1) * 30;
    let stream, recorder;
    try {
      stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0];
      if (!track?.requestFrame) throw new Error('이 브라우저에서 동영상 저장을 시작할 수 없습니다.');
      recorder = new MediaRecorder(stream, {mimeType, videoBitsPerSecond:3500000});
      const chunks = [];
      let recordError;
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = event => { recordError = event.error; };
      const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, {once:true}));
      recorder.start();
      const start = performance.now();
      for (let frame = 0; frame <= frameCount + 6; frame++) {
        if (recordError || recorder.state !== 'recording') throw recordError || new Error('동영상 저장이 중단됐습니다.');
        const position = Math.min(frameCount, frame) / 30;
        paintMorphFrame(sequence.scenes, position, drawing);
        track.requestFrame();
        await paintVideoCanvas(context, drawing);
        if (facadeSequence === sequence && frame % 6 === 0) {
          $('facadeMorphStatus').textContent = '동영상 만드는 중 · ' + Math.min(100, Math.round(frame / frameCount * 100)) + '%';
        }
        await new Promise(resolve => setTimeout(resolve, Math.max(4, start + (frame + 1) * frameMs - performance.now())));
      }
      recorder.stop();
      await stopped;
      if (recordError || !chunks.length) throw recordError || new Error('동영상이 생성되지 않았습니다.');
      const link = element('a');
      const url = URL.createObjectURL(new Blob(chunks, {type:mimeType}));
      link.href = url;
      link.download = '입면_모핑.webm';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (facadeSequence === sequence) $('facadeMorphStatus').textContent = '동영상 저장 완료';
    } catch (error) {
      if (facadeSequence === sequence) $('facadeMorphStatus').textContent = readable(error);
    } finally {
      if (recorder?.state === 'recording') recorder.stop();
      stream?.getTracks().forEach(track => track.stop());
      morphSaving = false;
      $('saveMorph').disabled = !facadeSequence || facadeSequence.photos.length < 2 || !facadeSequence.scenes.every(Boolean);
    }
  }


  function openFacade(mode) {
    const photos = job.photos;
    const key = JSON.stringify([job.id, ...photos.map(photo => photo.id)]);
    $('facadeSubtitle').textContent = (fromHistory ? '이전 분석 · ' : '') + photos.length + '장';
    if (key !== facadeListKey) {
      facadeListKey = key;
      facadeSequence = {jobId:job.id, photos, scenes:Array(photos.length).fill(null), loading:null};
      facadeView = 'overview';
      morphPosition = 0;
      drawPhotoList($('facadePhotoList'), photos, loadFacade);
      facadePhotoId = [mapPhotoId, $('analyzedPhoto').value].find(id => photos.some(photo => photo.id === id)) || photos[0].id;
    }
    return showFacadeView(mode || facadeView);
  }

  async function loadFacade(id) {
    const index = job.photos.findIndex(photo => photo.id === id);
    if (index === -1) return;
    const revision = ++facadeRevision;
    facadePhotoId = id;
    markPhoto($('facadePhotoList'), id);
    $('facadePhotoTitle').textContent = photoNumber(job.photos[index], index) + '번 사진';
    $('facadeOriginal').src = asset(job.id, id, 'source_rgb.png');
    $('facadeDrawing').setAttribute('hidden', '');
    $('facadePalettes').hidden = $('saveFacade').disabled = true;
    $('facadeStatus').textContent = '입면 색채 계산 중…';
    $('facadeStage').setAttribute('aria-busy', 'true');
    try {
      const {palettes} = await readFacadeScene(job.id, id);
      if (revision !== facadeRevision || phase !== 4) return;
      const houses = palettes.map(renderFacadePalette);
      $('facadeLeft').replaceChildren(...houses.slice(0, 2));
      $('facadeRight').replaceChildren(...houses.slice(2));
      $('facadePalettes').hidden = false;
      if (palettes.every(side => [...side.values()].every(colors => !colors.length))) {
        $('facadeStatus').textContent = '이 사진에서 분류된 입면 요소가 없습니다.';
        return;
      }
      drawFacade(palettes);
      $('facadeDrawing').removeAttribute('hidden');
      $('saveFacade').disabled = false;
      $('facadeStatus').textContent = '';
    } catch (error) {
      if (revision === facadeRevision) $('facadeStatus').textContent = readable(error);
    } finally {
      if (revision === facadeRevision) $('facadeStage').setAttribute('aria-busy', 'false');
    }
  }

  async function saveFacade() {
    const id = facadePhotoId;
    const svg = new XMLSerializer().serializeToString($('facadeDrawing'));
    const source = URL.createObjectURL(new Blob([svg], {type:'image/svg+xml;charset=utf-8'}));
    try {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = element('canvas');
      canvas.width = image.naturalWidth * 2;
      canvas.height = image.naturalHeight * 2;
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        if (!blob) return;
        const link = element('a');
        const url = URL.createObjectURL(blob);
        link.href = url;
        link.download = id + '_입면색채.png';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    } catch (error) {
      toast('입면 이미지를 저장할 수 없습니다.');
    } finally {
      URL.revokeObjectURL(source);
    }
  }


  function download(data, name, suffix) {
    if (!data) return;
    const link = element('a');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}));
    link.href = url;
    link.download = name.replace(/[<>:"/\\|?*]/g, '_') + suffix;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  choices($('analyzedClass'), ids.slice(1).map(id => [names[id], id]));
  $('analyzedClass').value = '13';
  const scopeOptions = [['전체 장면', 'scene'], ['분류된 요소 전체', 'all'], ...ids.map(id => [names[id], id])];
  choices($('roadClass'), scopeOptions);
  choices($('roadPhotoClass'), scopeOptions);
  document.querySelectorAll('[data-phase]').forEach(button => {
    button.onclick = () => enter(Number(button.dataset.phase)).catch(reportError);
  });
  document.querySelectorAll('[data-recap]').forEach(button => {
    button.onclick = () => enter(+button.dataset.recap).catch(reportError);
  });
  async function openLibrary(facadeMode) {
    if (captureBusy()) {
      toast('사진 수집이나 미리보기가 끝난 뒤 자료를 열어 주세요.');
      return;
    }
    libraryFacadeMode = facadeMode;
    $('loadAnalysis').textContent = facadeMode ? '선택한 분석으로 모핑 열기' : '분석 결과 열기';
    $('libraryStatus').textContent = '저장된 자료를 확인하는 중…';
    $('library').showModal();
    try {
      await refreshSources();
    } catch (error) {
      reportError(error);
    }
  }
  $('openLibrary').onclick = () => openLibrary();
  $('newResearch').onclick = () => {
    if (captureBusy() || loading || activeStates.includes(job?.state) || morphSaving) {
      toast('진행 중인 작업이 끝난 뒤 새 작업을 시작하세요.');
      return;
    }
    startCleanSession();
  };
  $('backToCapture').onclick = () => enter(1).catch(reportError);
  window.addEventListener('capture:show', () => {
    $('library').close();
    enter(1).catch(reportError);
  });
  $('handoffCapture').onclick = () => useRun(S.run).catch(reportError);
  $('captureRuns').onchange = buttons;
  $('captureArchive').onchange = async () => {
    buttons();
    if (!$('captureArchive').files.length || available) return;
    $('libraryStatus').textContent = '모델 준비 중…';
    try {
      applyModelInfo(await api('/api/analysis/info'));
      $('libraryStatus').textContent = $('modelState').textContent;
    } catch (error) {
      $('libraryStatus').textContent = readable(error);
    } finally {
      buttons();
    }
  };
  $('loadCapture').onclick = async () => {
    const run = await loadRun($('captureRuns').value);
    if (run) await useRun(run).catch(reportError);
    else $('libraryStatus').textContent = $('mainError').textContent;
  };
  $('analyzeRun').onclick = () => start(() => api('/api/analysis/run', {run_id:activeRun.run_id}));
  $('analyzeArchive').onclick = async () => {
    zipName = $('captureArchive').files[0].name;
    activeRun = null;
    resetJob();
    $('analysisCover').hidden = true;
    $('segmentTitle').textContent = '사진 분석';
    $('segmentSubtitle').textContent = zipName;
    $('library').close();
    const openPhase = enter(2);
    const beginJob = start(upload);
    await Promise.all([openPhase, beginJob]);
  };
  $('loadAnalysis').onclick = async () => {
    try {
      const next = await api(jobUrl($('analysisHistory').value));
      await useSavedAnalysis(next, libraryFacadeMode ? 4 : 2, libraryFacadeMode);
    } catch (error) {
      reportError(error);
    }
  };
  $('toRoad').onclick = () => enter(3).catch(reportError);
  $('toFacade').onclick = () => enter(4).catch(reportError);
  $('openSavedFacade').onclick = () => openLibrary('morph');
  $('saveFacade').onclick = saveFacade;
  document.querySelectorAll('[data-facade-view]').forEach(button => {
    button.onclick = () => showFacadeView(button.dataset.facadeView).catch(reportError);
  });
  $('facadeLayout').onchange = updateFacadeLayout;
  $('stackPosition').oninput = () => selectFacadeLayer(Number($('stackPosition').value), true);
  $('openStackPhoto').onclick = () => showFacadeView('detail', facadePhotoId).catch(reportError);
  $('facadeMedia').onchange = () => showFacadeView('overview').catch(reportError);
  $('playMorph').onclick = toggleMorph;
  $('morphPosition').oninput = () => {
    stopMorph();
    showMorphFrame(Number($('morphPosition').value) / 100);
  };
  $('saveMorph').onclick = exportMorph;
  for (const [id, offset] of [['prevPhoto', -1], ['nextPhoto', 1]]) {
    $(id).onclick = () => {
      $('analyzedPhoto').selectedIndex += offset;
      renderPhoto().catch(reportError);
    };
  }
  for (const id of ['analyzedPhoto', 'analyzedClass', 'photoView']) $(id).onchange = () => renderPhoto().catch(reportError);
  $('roadClass').onchange = () => renderRoad();
  $('roadPhotoClass').onchange = () => {
    if (roadPhotoView === 'source' && $('roadPhotoClass').value !== 'scene') roadPhotoView = 'overlay';
    return selectRoadPhoto(mapPhotoId);
  };
  document.querySelectorAll('[data-road-view]').forEach(button => {
    button.onclick = () => { roadPhotoView = button.dataset.roadView; renderRoadPhotoImage(); };
  });
  $('clearRoadColor').onclick = () => {
    selectedColor = null;
    markRoadColor(-1);
    renderRoadPhotoImage();
  };
  $('mapPhotoImage').onerror = () => { $('roadPhotoMetrics').textContent = '사진을 불러오지 못했습니다. 원본 보기로 다시 확인하세요.'; };
  $('saveRoad').onclick = () => download(roadReport, roadReport.capture_scope?.capture_folder || roadReport.road, '_색채.json');
  $('savePoints').onclick = () => download(pointsReport, roadReport.capture_scope?.capture_folder || roadReport.road, '_촬영점.geojson');
  buttons();
})();
