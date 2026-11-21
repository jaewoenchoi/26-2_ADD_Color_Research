'use strict';
const $=id=>document.getElementById(id),G=StreetGeo;
const S={token:null,map:null,pano:null,markers:[],photoMarkers:[],line:null,points:[],plan:null,mode:'start',running:false,previewing:false,connecting:false,authFailed:false,stopping:false,run:null,stream:null,screenCropped:false,fallbackDecision:null,captureHandle:crypto.randomUUID(),previousFingerprint:null};
let toastTimer;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const registrationUrl=()=>location.origin.replace(/:\d+$/,'');
const DRAFT_KEY = 'songjeong-capture-draft-v1';
const FRAME_TIMEOUT = '탭 캡처 화면의 새 프레임을 읽지 못했습니다.';
function message(text, reconnect = false) {
  $('mainError').textContent = text || '';
  $('captureNotice').hidden = !text;
  $('reconnectStorage').hidden = !reconnect;
  $('reconnectInProgress').hidden = !reconnect;
}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4200);}
function status(text,note){$('statusText').textContent=text;if(note)$('statusNote').textContent=note;}
function readable(error){return error?.message||(typeof error==='string'?error:'오류 세부 정보가 제공되지 않았습니다.');}
class StorageConnectionError extends Error {}
class ApiError extends Error {
  constructor(text, status) {
    super(text);
    this.status = status;
  }
}
async function api(path, payload) {
  const options = payload === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-Capture-Token': S.token},
    body: JSON.stringify(payload),
  };
  let response, data;
  try {
    response = await fetch(path, {...options, cache: 'no-store'});
    data = await response.json();
  } catch {
    throw new StorageConnectionError('사진 저장 프로그램과 연결이 끊겼습니다. 색채연구.exe를 다시 연 뒤 연결하세요.');
  }
  if (response.status === 403 && payload !== undefined) {
    throw new StorageConnectionError('사진 저장 프로그램의 연결이 만료됐습니다. 다시 연결하면 저장된 지점부터 이어갈 수 있습니다.');
  }
  if (response.status === 503) throw new StorageConnectionError(data.error);
  if (!response.ok) throw new ApiError(data.error || '요청을 완료하지 못했습니다.', response.status);
  return data;
}

function captureError(error) {
  const connectionLost = error instanceof StorageConnectionError;
  if (connectionLost) {
    S.token = null;
    $('openOutput').disabled = true;
  }
  message(readable(error), connectionLost);
}

function saveDraft() {
  try {
    const sameRoute = S.run && JSON.stringify(S.points) === JSON.stringify(S.run.route);
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
      points: S.points, runId: S.pendingRunId || S.restoreRunId || (sameRoute ? S.run.run_id : null),
    }));
  } catch { /* Storage may be disabled by browser policy. */ }
}

function startCleanSession() {
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* Browser storage is unavailable. */ }
  window.scrollTo(0, 0);
  location.reload();
}

function restoreDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY));
    if (!draft) return;
    S.points = draft.points.slice(0, 1000).map(G.point);
    if (/^[a-f0-9]{32}$/.test(draft.runId)) S.restoreRunId = draft.runId;
  } catch { /* Invalid or unavailable draft. */ }
}
function element(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
function setMode(mode) {
  S.mode = mode;
  for (const [id, value] of [['pickStart','start'], ['pickEnd','end'], ['pickVia','via']]) {
    $(id).classList.toggle('active', mode === value);
    $(id).setAttribute('aria-pressed', String(mode === value));
  }
  const guidance = {start:'지도에서 시작점을 찍으세요.', end:'지도에서 끝점을 찍으세요.',
    via:'지도에서 경로가 꺾이는 지점을 찍으세요.', idle:'경로를 확인하고 사진을 수집하세요.'};
  $('mapMode').textContent = guidance[mode];
  $('routeGuide').textContent = guidance[mode];
}
function settings(){return G.photoSettings({fov:$('fov').value,offset:$('headingOffset').value,snap:$('snapLimit').value,settle:Number($('settleMs').value)*1000});}
function captureBusy() { return Boolean(S.running || S.starting || S.previewing || S.connecting || S.reconnecting); }
function lock() {
  const busy = captureBusy();
  const hasSaved = Boolean(S.run?.photos.length && S.run.status !== 'running');
  document.body.classList.toggle('running', busy);
  for (const id of ['keyId','connectMap','showKey','routeLabel','fov','headingOffset','snapLimit','settleMs','applyCoordinates','coordinateInput']) $(id).disabled = busy;
  $('pickStart').disabled = busy || !S.map || S.authFailed;
  $('pickEnd').disabled = $('pickStart').disabled || S.points.length < 1;
  $('pickVia').disabled = $('pickStart').disabled || !S.plan;
  $('reverseRoute').disabled = busy || S.points.length < 2;
  $('clearRoute').disabled = busy || !S.points.length;
  $('startRun').disabled = busy || !S.plan || !S.pano || !S.token || S.authFailed;
  $('previewFirst').disabled = busy || !S.plan || !S.pano || S.authFailed;
  $('captureWorkspace').hidden = !S.map && !S.run;
  $('pauseRun').hidden = !S.running;
  $('pauseRun').disabled = S.stopping;
  $('handoffCapture').hidden = busy || !hasSaved;
  if (hasSaved) $('handoffCapture').textContent = `저장한 ${S.run.photos.length}장 분석으로 →`;
  $('openLibrary').disabled = busy;
  $('resumeRun').hidden = busy || !S.token || !S.run || S.run.status === 'complete' || !S.pano || S.authFailed;
  const missed = S.run?.events.filter(event => event.status === 'error' && event.reason === FRAME_TIMEOUT).length || 0;
  $('retryCapture').hidden = busy || !S.token || !S.pano || S.authFailed || !missed || S.run.status === 'running';
  if (missed) $('retryCapture').textContent = `누락된 ${missed}곳 다시 수집`;
  for (const marker of S.markers) marker.setOptions?.({draggable:!busy});
  for (const button of $('routePoints').querySelectorAll('button')) button.disabled = busy;
}
function updateRoute(){
  S.plan=null;let issue='';if(S.points.length>=2){try{S.plan=G.sample(S.points);}catch(error){issue=readable(error);}}
  $('routeLength').textContent=S.plan?(S.plan.length<1000?S.plan.length.toFixed(1)+'m':(S.plan.length/1000).toFixed(2)+'km'):'—';
  $('sampleCount').textContent=S.plan?S.plan.samples.length+'곳':'—';
  $('routeNote').textContent=issue||'시작부터 10m마다 요청합니다. 남은 끝 구간이 10m 미만이면 추가하지 않습니다.';
  $('routeNote').hidden = !issue;
  $('routePlan').hidden = !S.plan;
  $('routePoints').hidden = !S.points.length;
  if (S.map && !S.points.length) setMode('start');
  if (S.map && S.points.length === 1) setMode('end');
  $('routePoints').replaceChildren();if(!S.points.length)$('routePoints').append(element('p','hint','아직 지정한 지점이 없습니다.'));
  S.points.forEach((p,index)=>{const row=element('div','route-point'),label=index===0?'시작':index===S.points.length-1?'끝':'중간';row.append(element('span','point-name',label),element('code','',p.lat.toFixed(6)+', '+p.lon.toFixed(6)));const button=element('button','plain','×');button.setAttribute('aria-label',label+' 지점 삭제');button.disabled=S.running;button.onclick=()=>{S.points.splice(index,1);updateRoute();};row.append(button);$('routePoints').append(row);});
  renderMap();saveDraft();lock();
}
function renderMap(){if(!S.map)return;for(const marker of S.markers)marker.setMap(null);S.markers=[];if(S.line)S.line.setMap(null);const n=naver.maps;
  if(S.points.length>1)S.line=new n.Polyline({map:S.map,path:S.points.map(p=>new n.LatLng(p.lat,p.lon)),strokeColor:'#4b66aa',strokeWeight:4,strokeOpacity:.85});
  S.points.forEach((p,index)=>{const label=index===0?'시작':index===S.points.length-1?'끝':String(index),type=index===0?'start':index===S.points.length-1?'end':'via',marker=new n.Marker({map:S.map,position:new n.LatLng(p.lat,p.lon),draggable:!S.running,icon:{content:'<span class="naver-pin '+type+'">'+label+'</span>',anchor:new n.Point(17,15)}});n.Event.addListener(marker,'dragend',()=>{if(S.running)return;const point=marker.getPosition();S.points[index]={lat:point.lat(),lon:point.lng()};updateRoute();});S.markers.push(marker);});
}
function fitRoute(){if(!S.map||!S.points.length)return;const bounds=new naver.maps.LatLngBounds();for(const p of S.points)bounds.extend(new naver.maps.LatLng(p.lat,p.lon));S.map.fitBounds(bounds,45);}
function pickPoint(position) {
  if (captureBusy() || S.authFailed || S.mode === 'idle') return;
  const point = {lat:position.lat(), lon:position.lng()};
  if (S.mode === 'start') {
    S.points[0] = point;
    setMode('end');
  } else if (S.mode === 'end') {
    S.points[Math.max(1, S.points.length - 1)] = point;
    setMode('idle');
  } else if (S.plan) {
    // Insert the bend next to the closest segment.
    const {distance_m} = G.nearest(S.plan, point);
    const segment = S.plan.segments.findLastIndex(item => distance_m >= item.offset);
    S.points.splice(Math.min(S.points.length - 1, segment + 1), 0, point);
  }
  updateRoute();
}
// Preserve ordinary WebGL drawing buffers. This does not override canvas origin checks.
function preservePanoramaBuffers(){if(HTMLCanvasElement.prototype.__streetCapturePatched)return;const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,options){if((type==='webgl'||type==='webgl2'||type==='experimental-webgl')&&(S.creatingPanorama||$('panoHost').contains(this)))return original.call(this,type,{...(options||{}),preserveDrawingBuffer:true});return original.call(this,type,options);};HTMLCanvasElement.prototype.__streetCapturePatched=true;}
async function connectMap(){
  if(captureBusy())return;message('');if(!S.token){message('색채연구.exe를 다시 연 뒤 저장 프로그램에 연결하세요.',true);return;}if(S.map){message('Key ID를 변경하려면 페이지를 새로고침한 뒤 연결하세요.');return;}
  const key=$('keyId').value.trim();if(!key){message('네이버 클라우드 Maps Key ID를 입력하세요. 아직 발급받지 않았다면 아래 연결 안내를 확인하세요.');$('connection').open=true;return;}
  S.connecting=true;S.authFailed=false;lock();$('connectionBadge').textContent='연결 중';
  try{
    await new Promise((resolve,reject)=>{
      let settled=false;
      const done=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
      const timer=setTimeout(()=>done(new Error('네이버 지도를 불러오지 못했습니다. 인터넷, Web Dynamic Map 선택, Key ID와 허용 주소를 확인하세요.')),22000);
      window.__streetNaverReady=()=>done();
      window.navermap_authFailure=()=>{
        S.authFailed=true;S.stopping=S.running;
        const error=new Error('네이버 인증 실패: Key ID와 Web 서비스 URL '+registrationUrl()+'의 등록 여부를 확인하고 페이지를 새로고침하세요. 등록 주소에는 포트와 경로를 넣지 않습니다.');
        $('connectionBadge').textContent='인증 확인 필요';message(error.message);finishFallback(false);done(error);lock();
      };
      document.getElementById('naverSDK')?.remove();
      const script=document.createElement('script');script.id='naverSDK';script.async=true;
      script.src='https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId='+encodeURIComponent(key)+'&submodules=panorama&callback=__streetNaverReady';
      script.onerror=()=>done(new Error('네이버 API 연결에 실패했습니다. 인터넷과 브라우저의 콘텐츠 차단 설정을 확인하세요.'));
      document.head.append(script);
    });
    if(S.authFailed)throw new Error('네이버 인증에 실패했습니다. Key ID와 등록 주소를 확인한 뒤 페이지를 새로고침하세요.');
    if(!window.naver?.maps?.Panorama)throw new Error('네이버 파노라마 모듈을 사용할 수 없습니다. Web Dynamic Map 설정을 확인하세요.');
    $('mapEmpty')?.remove();$('previewCredit').hidden=true;S.map=new naver.maps.Map('mapHost',{center:new naver.maps.LatLng(37.552,127.069),zoom:16,zoomControl:true,zoomControlOptions:{position:naver.maps.Position.TOP_RIGHT}});
    naver.maps.Event.addListener(S.map,'click',e=>pickPoint(e.coord));
    preservePanoramaBuffers();S.creatingPanorama=true;$('captureWorkspace').hidden=false;$('panoEmpty')?.remove();
    S.pano=new naver.maps.Panorama('panoHost',{position:new naver.maps.LatLng(37.552,127.069),visible:true,pov:{pan:0,tilt:0,fov:90},aroundControl:false,zoomControl:false,flightSpot:false,logoControl:true});
    naver.maps.Event.addListener(S.pano,'init',()=>{S.creatingPanorama=false;showPanoInfo();});
    naver.maps.Event.addListener(S.pano,'pano_changed',showPanoInfo);
    $('connectionBadge').textContent='연결됨';$('connection').open=false;setMode(S.points.length > 1 ? 'idle' : S.points.length ? 'end' : 'start');updateRoute();fitRoute();status('수집 시작 전');
    for (const [id, target] of [['mapHost', S.map], ['panoHost', S.pano]]) {
      const resize = new ResizeObserver(() => {
        const {width, height} = $(id).getBoundingClientRect();
        if (!S.running && width && height) target.setSize(new naver.maps.Size(Math.round(width), Math.round(height)));
      });
      resize.observe($(id));
    }
  }catch(error){$('connectionBadge').textContent='연결 확인 필요';message(readable(error));}finally{S.connecting=false;S.creatingPanorama=false;lock();}
}
function readPano(){if(!S.pano)throw new Error('네이버 지도를 먼저 연결하세요.');const info=S.pano.getLocation(),coord=info?.coord;if(!coord)throw new Error('촬영 좌표가 아직 준비되지 않았습니다.');const latitude=typeof coord.lat==='function'?coord.lat():coord.lat,longitude=typeof coord.lng==='function'?coord.lng():coord.lng,p=G.point({lat:latitude,lon:longitude}),pov=S.pano.getPov(),panoId=String(info.panoId||S.pano.getPanoId()||'');if(!panoId)throw new Error('파노라마 ID가 없습니다.');return {pano_id:panoId,latitude:p.lat,longitude:p.lon,road_name:info.title||'',address:info.address||'',photo_date_raw:info.photodate||'',heading:G.normalize(Number(pov.pan)),tilt:Number(pov.tilt),fov:Number(pov.fov)};}
function showPanoInfo(){try{const meta=readPano();$('panoRoad').textContent=meta.road_name||'도로명 미제공';$('panoCoordinates').textContent=meta.latitude.toFixed(6)+', '+meta.longitude.toFixed(6);$('panoDate').textContent='촬영 '+(meta.photo_date_raw||'미상');}catch{}}
async function lookup(position){await new Promise((resolve,reject)=>{let listener;const timer=setTimeout(()=>{if(listener)naver.maps.Event.removeListener(listener);reject(new Error('거리뷰 조회 응답이 없습니다. 이 지점을 건너뜁니다.'));},18000);listener=naver.maps.Event.addListener(S.pano,'pano_status',value=>{const state=typeof value==='string'?value:value?.status;if(state!=='OK'&&state!=='ERROR')return;clearTimeout(timer);naver.maps.Event.removeListener(listener);state==='OK'?resolve():reject(new Error('이 지점에서 거리뷰를 찾지 못했습니다.'));});try{S.pano.setPosition(new naver.maps.LatLng(position.lat,position.lon));}catch(error){clearTimeout(timer);naver.maps.Event.removeListener(listener);reject(error);}});return readPano();}
async function prepareSample(sample,plan,config){let meta=await lookup(sample);const actual={lat:meta.latitude,lon:meta.longitude},match=G.inverse(sample,actual).distance,nearest=G.nearest(plan,actual);if(match>config.snap||nearest.distance>config.snap)throw new Error('촬영 위치가 선택한 경로에서 멉니다 ('+match.toFixed(1)+'m).');const heading=G.normalize(nearest.heading+config.offset);S.pano.setPov({pan:heading>180?heading-360:heading,tilt:0,fov:config.fov});await sleep(config.settle);const after=readPano();if(after.pano_id!==meta.pano_id)throw new Error('조회 중 촬영 위치가 바뀌었습니다. 다시 실행하세요.');if(Math.abs(after.tilt)>1||Math.abs(((after.heading-heading+540)%360)-180)>1||Math.abs(after.fov-config.fov)>1)throw new Error('정면 시야 설정이 아직 반영되지 않았습니다.');return {...after,match_distance_m:match,route_offset_m:nearest.distance,actual_route_distance_m:nearest.distance_m};}
async function previewFirst(){if(!S.plan||!S.pano||S.running||S.previewing)return;message('');S.previewing=true;lock();try{status('첫 지점 거리뷰 준비 중');await prepareSample(S.plan.samples[0],S.plan,settings());showPanoInfo();$('panoHost').scrollIntoView({block:'center',behavior:'instant'});status('첫 지점 정면 미리보기','도로 중앙을 향하는지 확인하세요. 어긋나면 정면 보정 값을 조절할 수 있습니다.');}catch(error){message(readable(error));status('미리보기를 확인할 수 없습니다.');}finally{S.previewing=false;lock();}}
class NeedsTabCapture extends Error{}
function nonBlank(ctx,width,height){
  const image=ctx.getImageData(0,0,width,height),data=image.data,mean=[0,0,0],variance=[0,0,0];
  let max=0,visible=0;const stride=Math.max(1,Math.floor(width*height/800));
  for(let p=0;p<width*height;p+=stride){const i=p*4;if(data[i+3]>30){visible++;for(let channel=0;channel<3;channel++){const value=data[i+channel],delta=value-mean[channel];mean[channel]+=delta/visible;variance[channel]+=delta*(value-mean[channel]);max=Math.max(max,value);}}}
  if(visible<5||max<7||variance.reduce((a,b)=>a+b,0)/Math.max(visible,1)<9)throw new Error('빈 화면·검정 화면 또는 단색 대기 화면이 감지되었습니다.');
  return image;
}
async function fingerprint(data){const bytes=await crypto.subtle.digest('SHA-256',data);return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
function newCanvas(width,height){const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;}
async function finishImage(scene,method){const width=scene.width,height=scene.height,ctx=scene.getContext('2d',{willReadFrequently:true}),pixels=nonBlank(ctx,width,height),hash=await fingerprint(pixels.data),footer=28,out=newCanvas(width,height+footer),outCtx=out.getContext('2d');outCtx.drawImage(scene,0,0);outCtx.fillStyle='#ffffff';outCtx.fillRect(0,height,width,footer);outCtx.fillStyle='#46546a';outCtx.font='12px system-ui, sans-serif';outCtx.fillText('NAVER Maps · Street imagery',10,height+18);return {png:out.toDataURL('image/png'),scene_height:height,capture_method:method,scene_sha256:hash};}
async function directCanvas(){const host=$('panoHost'),rect=host.getBoundingClientRect(),candidates=Array.from(host.querySelectorAll('canvas')).map(canvas=>({canvas,rect:canvas.getBoundingClientRect()})).filter(item=>item.canvas.width>16&&item.canvas.height>16&&getComputedStyle(item.canvas).visibility!=='hidden'&&getComputedStyle(item.canvas).display!=='none'&&item.rect.width*item.rect.height>=rect.width*rect.height*.85).sort((a,b)=>b.rect.width*b.rect.height-a.rect.width*a.rect.height);if(!candidates.length)throw new NeedsTabCapture('현재 거리뷰에서 직접 읽을 수 있는 이미지 캔버스가 없습니다.');let reason='';for(const item of candidates){try{await new Promise(resolve=>requestAnimationFrame(resolve));const source=item.canvas,box=item.rect,sx=(rect.left-box.left)*source.width/box.width,sy=(rect.top-box.top)*source.height/box.height,sw=rect.width*source.width/box.width,sh=rect.height*source.height/box.height;if(sx<-.5||sy<-.5||sx+sw>source.width+.5||sy+sh>source.height+.5)continue;const scene=newCanvas(Math.round(sw),Math.round(sh));scene.getContext('2d').drawImage(source,sx,sy,sw,sh,0,0,scene.width,scene.height);return await finishImage(scene,'canvas_scene');}catch(error){reason=readable(error);}}throw new NeedsTabCapture('브라우저가 원본 화면 읽기를 허용하지 않거나 빈 화면을 반환했습니다. '+reason);}
async function nextVideoFrame(video) {
  if (typeof video.requestVideoFrameCallback === 'function') {
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        video.cancelVideoFrameCallback(id);
        resolve();
      }, 2500);
      const id = video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  } else {
    await sleep(180);
  }
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new NeedsTabCapture(FRAME_TIMEOUT);
}
async function sharedCapture() {
  const track = S.stream?.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') throw new NeedsTabCapture('탭 공유 연결이 종료되었습니다.');
  const host = $('panoHost'), video = $('sharedVideo');
  // Keep the sticky step bar out of the captured pixels.
  document.body.classList.add('capturing-screen');
  try {
    host.scrollIntoView({block:'center', behavior:'instant'});
    await sleep(220);
    await nextVideoFrame(video);
    const region = S.screenCropped
      ? {x:0, y:0, width:video.videoWidth, height:video.videoHeight}
      : G.captureRect(host.getBoundingClientRect(), {width:innerWidth, height:innerHeight},
        {width:video.videoWidth, height:video.videoHeight});
    if (region.width < 16 || region.height < 16) throw new Error('거리뷰 캡처 영역이 너무 작습니다.');
    const scene = newCanvas(region.width, region.height);
    scene.getContext('2d').drawImage(video, region.x, region.y, region.width, region.height, 0, 0, scene.width, scene.height);
    return finishImage(scene, 'shared_tab_viewport');
  } finally {
    document.body.classList.remove('capturing-screen');
  }
}
function stopSharing(){for(const track of S.stream?.getTracks()||[])track.stop();S.stream=null;S.screenCropped=false;$('sharedVideo').srcObject=null;}
async function prepareTabSharing(){
  if(!navigator.mediaDevices?.getDisplayMedia)throw new Error('현재 브라우저는 탭 캡처를 지원하지 않습니다. 최신 Chrome 또는 Edge에서 실행하세요.');
  stopSharing();const stream=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'browser',cursor:'never',frameRate:15},audio:false,preferCurrentTab:true,selfBrowserSurface:'include',surfaceSwitching:'exclude',monitorTypeSurfaces:'exclude'});
  const track=stream.getVideoTracks()[0];try{if(track.getSettings().displaySurface!=='browser')throw new Error('전체 화면이나 창이 아닌 현재 이 도구의 브라우저 탭을 선택하세요.');const handle=typeof track.getCaptureHandle==='function'?track.getCaptureHandle():null;if(handle&&handle.handle!==S.captureHandle)throw new Error('다른 탭을 선택했습니다. 현재 거리 사진 수집 도구의 탭을 선택하세요.');let cropped=false;if(window.CropTarget?.fromElement&&typeof track.cropTo==='function'){try{const target=await CropTarget.fromElement($('panoHost'));await track.cropTo(target);cropped=true;}catch{}}
    if(!cropped&&handle?.handle!==S.captureHandle)throw new Error('현재 탭인지 확인할 수 없습니다. 최신 Chrome 또는 Edge에서 다시 시도하세요.');
    S.stream=stream;S.screenCropped=cropped;$('sharedVideo').srcObject=stream;await $('sharedVideo').play();await nextVideoFrame($('sharedVideo'));track.addEventListener('ended',()=>{S.stream=null;S.screenCropped=false;});$('captureMode').textContent='탭 캡처 · 거리뷰 영역만 저장';
  }catch(error){for(const mediaTrack of stream.getTracks())mediaTrack.stop();throw error;}
}
async function captureImage() {
  try {
    if (S.stream) return await sharedCapture();
    const result = await directCanvas();
    $('captureMode').textContent = '이미지 캔버스 직접 추출';
    return result;
  } catch (error) {
    if (error instanceof NeedsTabCapture) throw error;
    throw new NeedsTabCapture(readable(error));
  }
}
function waitForFallback(reason) {
  stopSharing();
  $('fallbackReason').textContent = reason;
  $('shareError').hidden = true;
  $('fallbackBox').hidden = false;
  status('탭 공유 대기', '공유 후 이 지점부터 저장을 이어갑니다.');
  $('fallbackBox').scrollIntoView({block:'nearest'});
  return new Promise(resolve => { S.fallbackDecision = resolve; });
}
function finishFallback(continueRun){const resolve=S.fallbackDecision;S.fallbackDecision=null;$('fallbackBox').hidden=true;resolve?.(continueRun);}
async function shareTabClicked() {
  if (!S.fallbackDecision) return;
  $('shareError').hidden = true;
  $('shareTab').disabled = true;
  try {
    await prepareTabSharing();
    if (S.fallbackDecision) finishFallback(true);
    else stopSharing();
  } catch (error) {
    $('shareError').textContent = error.name === 'NotAllowedError'
      ? '탭 공유가 취소됐습니다. 다시 눌러 현재 탭을 선택하세요.'
      : readable(error);
    $('shareError').hidden = false;
  } finally {
    $('shareTab').disabled = false;
  }
}
function isDuplicate(meta){return S.run.photos.some(photo=>photo.pano_id===meta.pano_id||G.inverse({lat:photo.latitude,lon:photo.longitude},{lat:meta.latitude,lon:meta.longitude}).distance<.5);}
function updateProgress(index){const run=S.run;if(!run)return;$('progress').max=run.samples.length;$('progress').value=index;$('progressCount').textContent=index+' / '+run.samples.length;$('savedCount').textContent=run.photos.length;$('duplicateCount').textContent=run.events.filter(e=>e.status==='duplicate').length;$('failedCount').textContent=run.events.filter(e=>e.status!=='duplicate').length;$('currentFolders').textContent=run.capture_folder ? '저장 폴더 · ' + run.capture_folder : Object.values(run.road_folders).join(' · ')||'저장된 사진이 없습니다.';if(run.photos.length){$('downloadRun').href='/api/export/'+run.run_id;$('downloadRun').hidden=false;}else $('downloadRun').hidden=true;}
function photoPath(path){return '/'+path.split('/').map(encodeURIComponent).join('/');}
function addPhoto(photo){if($('photoStrip').querySelector('.empty-result'))$('photoStrip').replaceChildren();const card=element('div','photo-card'),image=element('img');image.src=photoPath(photo.file_path);image.alt=photo.road_name+' '+photo.latitude.toFixed(6)+', '+photo.longitude.toFixed(6);image.loading='lazy';const body=element('div');body.append(element('strong','',photo.sequence+' · '+photo.road_name),element('code','',photo.latitude.toFixed(6)+', '+photo.longitude.toFixed(6)));const link=element('a','','사진 열기 ↗');link.href=photoPath(photo.file_path);link.target='_blank';link.rel='noreferrer';body.append(link);card.append(image,body);$('photoStrip').append(card);if(S.map){S.photoMarkers.push(new naver.maps.Marker({map:S.map,position:new naver.maps.LatLng(photo.latitude,photo.longitude),icon:{content:'<span class="captured-pin"></span>',anchor:new naver.maps.Point(5,5)}}));}}
function resetPhotos(){for(const marker of S.photoMarkers)marker.setMap(null);S.photoMarkers=[];$('photoStrip').replaceChildren(element('div','empty-result','저장한 사진과 실제 좌표를 여기에 표시합니다.'));S.previousFingerprint=null;}
async function startRun() {
  if (captureBusy() || S.authFailed || !S.plan || !S.pano || !S.token) return;
  message('');
  S.starting = true;
  lock();
  try {
    const config = settings();
    S.pendingRunId = crypto.randomUUID().replaceAll('-', '');
    saveDraft();
    S.run = await api('/api/run', {run_id:S.pendingRunId, route:S.points, samples:S.plan.samples,
      length_m:S.plan.length, settings:config, label:$('routeLabel').value});
    S.pendingRunId = null;
    S.interrupted = false;
    saveDraft();
    S.starting = false;
    resetPhotos();
    $('captureWorkspace').scrollIntoView({block:'start'});
    await runLoop();
  } catch (error) {
    if (!(error instanceof StorageConnectionError)) {
      S.pendingRunId = null;
      saveDraft();
    }
    captureError(error);
  } finally {
    S.starting = false;
    lock();
  }
}
async function logEvent(index,state,reason){S.run=await api('/api/event',{run_id:S.run.run_id,index,status:state,reason});}
async function runLoop(){
  const runId=S.run.run_id,plan=G.sample(S.run.route),config=S.run.settings;S.running=true;S.stopping=false;message('');lock();let failed=false;
  const finishedPoints = new Set([
    ...S.run.photos.map(photo => photo.sample_index),
    ...S.run.events.map(event => event.index),
  ]);
  try{for(let index=S.run.next_index;index<plan.samples.length;index++){
    if(S.stopping)break;
    if (finishedPoints.has(index)) continue;
    const sample=plan.samples[index];updateProgress(index);status((index+1)+'번째 지점 · '+sample.distance_m+'m','도로의 진행 방향으로 거리뷰를 준비하고 있습니다.');
    try{let metadata=await prepareSample(sample,plan,config);showPanoInfo();if(isDuplicate(metadata)){await logEvent(index,'duplicate','이미 저장한 파노라마 또는 동일 촬영 위치입니다.');updateProgress(index+1);continue;}
      let image;while(!image){try{image=await captureImage();}catch(error){if(!(error instanceof NeedsTabCapture))throw error;const proceed=await waitForFallback(readable(error));if(!proceed){S.stopping=true;break;}await sleep(300);}}
      if(!image)break;
      if (S.previousFingerprint === image.scene_sha256) {
        await sleep(1800);
        image = await captureImage();
        if (S.previousFingerprint === image.scene_sha256) {
          throw new NeedsTabCapture('이전 지점의 화면이 남아 있습니다. 현재 탭을 다시 공유해 이 지점을 계속하세요.');
        }
      }
      const after=readPano();if(after.pano_id!==metadata.pano_id||G.inverse({lat:after.latitude,lon:after.longitude},{lat:metadata.latitude,lon:metadata.longitude}).distance>.2||Math.abs(((after.heading-metadata.heading+540)%360)-180)>.5||Math.abs(after.fov-metadata.fov)>.5||Math.abs(after.tilt-metadata.tilt)>.5)throw new Error('캡처 중 위치 또는 시야가 바뀌었습니다. 저장하지 않았습니다.');
      status((index+1)+'번째 사진 저장 중','실제 촬영 좌표를 PNG 내부 GPS와 JSON·CSV에 기록합니다.');
      const response=await api('/api/photo',{run_id:runId,index,png:image.png,metadata:{...metadata,...image,png:undefined}});
      if(response.duplicate){await logEvent(index,'duplicate','실행 안의 같은 위치는 한 장만 저장합니다.');}else{S.run=response.run;S.previousFingerprint=image.scene_sha256;addPhoto(response.photo);}updateProgress(index+1);
    }catch(error){if(error instanceof StorageConnectionError)throw error;if(error instanceof NeedsTabCapture){const proceed=await waitForFallback(readable(error));if(!proceed){S.stopping=true;break;}index--;continue;}await logEvent(index,'error',readable(error));updateProgress(index+1);status('이 지점은 저장하지 못했습니다. 다음 지점으로 이동합니다.',readable(error));}
  }
  S.run=await api('/api/finish',{run_id:runId,status:S.stopping?'paused':'complete'});status(S.stopping?'중단됨 · '+S.run.photos.length+'장 저장':'수집 완료 · '+S.run.photos.length+'장 저장',S.stopping?'완료한 사진은 유지됩니다. 같은 실행을 이어서 진행할 수 있습니다.':'도로명 폴더와 사진의 좌표를 확인하세요. 누락과 중복은 run.json에 기록됩니다.');
  } catch (error) {
    failed = true;
    S.interrupted = true;
    captureError(error);
    status('수집이 멈췄습니다.', error instanceof StorageConnectionError
      ? '다시 연결한 뒤 저장된 지점부터 이어갈 수 있습니다.'
      : '수집 이어가기를 누르면 마지막으로 저장된 지점부터 확인합니다.');
    saveDraft();
  } finally {
    S.running = false;
    S.stopping = false;
    finishFallback(false);
    stopSharing();
    lock();
    updateProgress(S.run?.next_index || 0);
    if (S.token) await refreshHistory().catch(() => {});
    if (!failed && S.run?.photos.length) toast('저장 폴더에 결과를 기록했습니다.');
  }
}
function showRun(run) {
  S.run = run;
  S.pendingRunId = S.restoreRunId = null;
  S.interrupted = false;
  S.points = run.route.map(point => ({...point}));
  for (const [key, field] of [['fov','fov'], ['offset','headingOffset'], ['snap','snapLimit']]) $(field).value = run.settings[key];
  $('settleMs').value = run.settings.settle / 1000;
  $('routeLabel').value = run.label;
  if (S.map && S.points.length > 1) setMode('idle');
  updateRoute();
  fitRoute();
  resetPhotos();
  for (const photo of run.photos) addPhoto(photo);
  S.previousFingerprint = run.photos.at(-1)?.scene_sha256 || null;
  updateProgress(run.next_index);
  const note = run.status === 'complete' ? '저장된 사진을 확인하세요.' :
    S.pano ? '수집 이어가기를 누르면 다음 지점에서 시작합니다.' : '네이버 지도를 연결한 뒤 수집을 이어갈 수 있습니다.';
  status(`수집 기록 · ${run.photos.length}장 저장`, note);
}

async function retryMissingCapture() {
  if (captureBusy() || !S.run || !S.pano || !S.token || S.authFailed) return;
  S.starting = true;
  lock();
  try {
    showRun(await api('/api/retry-capture', {run_id:S.run.run_id}));
    S.starting = false;
    $('captureWorkspace').scrollIntoView({block:'start'});
    await runLoop();
  } catch (error) {
    S.interrupted = error instanceof StorageConnectionError;
    captureError(error);
  } finally {
    S.starting = false;
    lock();
  }
}

async function reconnectStorage() {
  if (captureBusy()) return;
  S.reconnecting = true;
  $('reconnectStorage').disabled = $('reconnectInProgress').disabled = true;
  lock();
  try {
    const info = await api('/api/info');
    S.token = info.token;
    const runId = S.pendingRunId || S.restoreRunId || (S.interrupted ? S.run?.run_id : null);
    if (runId) {
      try {
        showRun(await api('/api/run/' + runId));
      } catch (error) {
        if (error.status !== 404) throw error;
        S.pendingRunId = S.restoreRunId = null;
        S.interrupted = false;
        saveDraft();
      }
    }
    message('');
    $('openOutput').disabled = false;
    await refreshHistory();
  } catch (error) {
    captureError(error);
  } finally {
    S.reconnecting = false;
    $('reconnectStorage').disabled = $('reconnectInProgress').disabled = false;
    lock();
  }
}

async function loadRun(id, resume = false) {
  if (captureBusy()) return;
  message('');
  try {
    showRun(await api('/api/run/' + id));
    if (resume && S.run.status !== 'complete') {
      if (!S.pano || S.authFailed) {
        message('네이버 지도를 먼저 연결하면 이 실행을 이어서 진행할 수 있습니다.');
        return;
      }
      await runLoop();
    }
    return S.run;
  } catch (error) {
    captureError(error);
    lock();
  }
}
async function refreshHistory(){const history=await api('/api/history');$('historyCount').textContent=history.length;$('historyList').replaceChildren();if(!history.length)$('historyList').append(element('p','hint','실행 기록이 없습니다.'));for(const run of history.slice(0,30)){const row=element('div','history-row'),body=element('div'),button=element('button','plain','불러오기');body.append(element('p','',run.folders.join(' · ')||run.label||'아직 사진 없음'),element('small','',new Date(run.created_at).toLocaleString('ko-KR')+' · '+run.saved+'장 / '+run.planned+'요청 · '+({running:'진행 기록',paused:'중단',complete:'완료',error:'연결 오류'}[run.status]||run.status)));button.onclick=async()=>{if(await loadRun(run.run_id))window.dispatchEvent(new Event('capture:show'));};row.append(body,button);$('historyList').append(row);}}
function applyCoordinateInput(){if(captureBusy())return;message('');try{const lines=$('coordinateInput').value.trim().split(/\r?\n/).filter(line=>line.trim()),points=lines.map(line=>{const values=line.trim().split(/[,\s]+/);if(values.length!==2)throw new Error('각 줄에 위도, 경도 두 값을 입력하세요.');return G.point({lat:values[0],lon:values[1]});});G.sample(points);S.points=points;if(S.map)setMode('idle');updateRoute();fitRoute();}catch(error){message(readable(error));}}
async function boot(){
  $('serviceOrigin').textContent=registrationUrl();
  $('connectMap').onclick=connectMap;$('showKey').onclick=()=>{$('keyId').type=$('keyId').type==='password'?'text':'password';$('showKey').textContent=$('keyId').type==='password'?'보기':'숨김';};
  $('keyId').onkeydown = event => { if (event.key === 'Enter') connectMap(); };
  $('copyOrigin').onclick=async()=>{try{await navigator.clipboard.writeText(registrationUrl());toast('네이버에 등록할 주소를 복사했습니다.');}catch{toast('표시된 주소를 직접 복사하세요.');}};
  for(const [id,mode] of [['pickStart','start'],['pickEnd','end'],['pickVia','via']])$(id).onclick=()=>setMode(mode);
  $('applyCoordinates').onclick=applyCoordinateInput;$('reverseRoute').onclick=()=>{S.points.reverse();updateRoute();};$('clearRoute').onclick=()=>{S.points=[];updateRoute();};
  $('previewFirst').onclick=previewFirst;$('startRun').onclick=startRun;
  $('pauseRun').onclick=()=>{S.stopping=true;lock();status('중단 요청 · 현재 사진 후 멈춥니다.');if(S.fallbackDecision)finishFallback(false);};
  $('shareTab').onclick=shareTabClicked;$('cancelFallback').onclick=()=>{S.stopping=true;finishFallback(false);};
  $('resumeRun').onclick=()=>{if(S.run)loadRun(S.run.run_id,true);};
  $('retryCapture').onclick=retryMissingCapture;
  $('reconnectStorage').onclick=$('reconnectInProgress').onclick=reconnectStorage;
  $('openOutput').onclick=async()=>{try{const response=await api('/api/open-output',{run_id:S.run?.run_id ?? null});toast('저장 위치: '+response.path);}catch(error){captureError(error);lock();}};
  window.addEventListener('beforeunload',event=>{if(S.running){event.preventDefault();event.returnValue='';}});
  window.addEventListener('pagehide',stopSharing);
  try{navigator.mediaDevices?.setCaptureHandleConfig?.({handle:S.captureHandle,exposeOrigin:true,permittedOrigins:[location.origin]});}catch{}
  if(location.protocol==='file:'){message('압축을 모두 풀고 색채연구.exe를 실행해 작업 화면을 여세요.');return;}
  restoreDraft();
  if (S.points.length) updateRoute();
  await reconnectStorage();
}
if(!globalThis.STREET_CAPTURE_TEST)boot();
