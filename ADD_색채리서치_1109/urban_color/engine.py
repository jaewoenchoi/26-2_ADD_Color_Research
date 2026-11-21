from __future__ import annotations
import json, re, threading
from pathlib import Path
import numpy as np
from PIL import Image
import torch
from torchvision.models.segmentation import deeplabv3_mobilenet_v3_large
from .core import rgb_source, predict, export_bundle, sha, write_json

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
ID_PATTERN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$')
RESERVED = {'CON','PRN','AUX','NUL'} | {f'{p}{i}' for p in ['COM','LPT'] for i in range(1,10)}

class ContractError(ValueError):
    def __init__(self, code, message):
        self.code=code
        super().__init__(message)

def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8-sig'),
            parse_constant=lambda x: (_ for _ in ()).throw(ValueError('Nonfinite JSON number')))
    except (OSError,ValueError) as e:
        raise ContractError('INVALID_JSON',str(e)) from e

def check_id(image_id):
    if not isinstance(image_id,str) or not ID_PATTERN.fullmatch(image_id) or image_id.upper() in RESERVED:
        raise ContractError('INVALID_IMAGE_ID','Use 1-80 ASCII letters/digits/_/-, starting with a letter or digit; avoid Windows device names.')

def validate_metadata(value, image_id):
    if value is None:return
    if not isinstance(value,dict):raise ContractError('INVALID_METADATA','Metadata must be a JSON object.')
    try:json.dumps(value,allow_nan=False)
    except (ValueError,TypeError) as e:raise ContractError('INVALID_METADATA',str(e)) from e
    if 'image_id' in value and value['image_id']!=image_id:
        raise ContractError('IMAGE_ID_MISMATCH','Metadata image_id must equal request image_id.')
    loc=value.get('location')
    if loc is not None:
        if not isinstance(loc,dict):raise ContractError('INVALID_LOCATION','location must be an object or null.')
        lat,lon=loc.get('latitude'),loc.get('longitude')
        if (lat is None)!=(lon is None):raise ContractError('INVALID_LOCATION','Supply both latitude and longitude, or neither.')
        if lat is not None:
            if (isinstance(lat,bool) or isinstance(lon,bool) or not isinstance(lat,(float,int))
                or not isinstance(lon,(float,int)) or not -90<=lat<=90 or not -180<=lon<=180):
                raise ContractError('INVALID_LOCATION','Invalid WGS84 latitude/longitude.')
            if loc.get('crs')!='EPSG:4326':raise ContractError('INVALID_LOCATION','Coordinates require crs=EPSG:4326.')

def resolve_metadata(metadata_path, metadata, image_id):
    if metadata_path is not None and metadata is not None:
        raise ContractError('AMBIGUOUS_METADATA','Use metadata_path OR metadata, not both.')
    value=read_json(metadata_path) if metadata_path is not None else metadata
    validate_metadata(value,image_id)
    return value

def validate_image(path):
    path=Path(path)
    if path.suffix.lower() not in {'.jpg','.jpeg','.png'} or not path.is_file():
        raise ContractError('INVALID_IMAGE','Expected an existing JPG/JPEG/PNG file.')
    try:
        with Image.open(path) as im:
            if im.format not in {'JPEG','PNG'} or im.mode!='RGB':
                raise ContractError('UNSUPPORTED_IMAGE_MODE','Only 8-bit RGB JPEG/PNG is supported; no implicit conversion.')
            if im.width*im.height>25_000_000:raise ContractError('IMAGE_TOO_LARGE','Limit: 25 megapixels per image.')
            im.verify()
    except ContractError:raise
    except Exception as e:raise ContractError('INVALID_IMAGE',str(e)) from e
    return path

class Segmenter:
    """Load once per worker, reuse across jobs. Never trains or downloads weights."""
    def __init__(self, model='baseline', device='auto', package_root=None):
        self.root=Path(package_root) if package_root else PACKAGE_ROOT
        self.catalog=read_json(self.root/'models/catalog.json')
        if model not in self.catalog['models']:raise ContractError('UNKNOWN_MODEL',str(model))
        self.model_id=model;self.model_info=self.catalog['models'][model]
        checkpoint=self.root/'models'/self.model_info['file']
        if sha(checkpoint)!=self.model_info['sha256']:raise ContractError('MODEL_HASH_MISMATCH','Checkpoint checksum mismatch.')
        if device not in {'cpu','cuda','auto'}:raise ContractError('INVALID_DEVICE','Choose cpu, cuda, or auto.')
        if device=='cuda' and not torch.cuda.is_available():raise ContractError('CUDA_UNAVAILABLE','CUDA is not available; use cpu.')
        self.device=torch.device('cuda' if device=='auto' and torch.cuda.is_available() else 'cpu' if device=='auto' else device)
        cp=torch.load(checkpoint,map_location='cpu',weights_only=True)
        self.registry=read_json(self.root/'class_registry.json')
        if cp['registry']['classes']!=self.registry['classes']:raise ContractError('CLASS_MAPPING_MISMATCH','Checkpoint class mapping differs from registry.')
        self.config=cp['config'];self.epoch=cp['epoch']
        if self.config['architecture']!='deeplabv3_mobilenet_v3_large' or self.config['num_classes']!=15 or self.config['size']!=512:
            raise ContractError('MODEL_CONFIG_MISMATCH','Unsupported architecture/configuration.')
        self.model=deeplabv3_mobilenet_v3_large(weights=None,weights_backbone=None,num_classes=15,aux_loss=False)
        self.model.load_state_dict(cp['state_dict'],strict=True)
        self.model.to(self.device).eval();self.lock=threading.Lock()

    def segment(self, image_path, output_dir, image_id, *, metadata_path=None, metadata=None):
        """output_dir is a NEW per-image bundle directory, not its parent."""
        check_id(image_id);source=validate_image(image_path)
        upstream=resolve_metadata(metadata_path,metadata,image_id)
        dest=Path(output_dir)
        if dest.exists() or dest.with_name(dest.name+'.partial').exists():
            raise ContractError('OUTPUT_EXISTS','Output or .partial directory already exists; use a new job directory.')
        rgb,_,_=rgb_source(source)
        with self.lock:
            labels,geometry=predict(self.model,rgb,512,self.device)
        provenance={'kind':'model_prediction','model_id':self.model_id,
            'model_status':self.model_info['status'],'checkpoint_sha256':self.model_info['sha256'],
            'checkpoint_epoch':self.epoch,'training_image_count':self.model_info['training_image_count'],
            'dataset_sha256':self.config['dataset_sha256'],'mapping_version':self.registry['version'],
            'preprocessing':geometry,'device':str(self.device)}
        # Outer staging keeps the FINAL ready directory invisible until the wrapper has finished.
        stage=dest.with_name(dest.name+'.partial')
        if stage.with_name(stage.name+'.partial').exists():raise ContractError('OUTPUT_EXISTS','Stale nested partial directory exists.')
        manifest=export_bundle(source,labels,stage,self.registry,provenance,metadata_path)
        manifest['schema_version']='1.1'
        manifest['sample_id']=image_id
        manifest['metadata_status']='provided_file' if metadata_path is not None else 'provided_inline' if upstream is not None else 'not_provided'
        manifest['upstream_metadata']=upstream;manifest['location']=upstream.get('location') if upstream is not None else None
        if upstream is not None and metadata_path is None:
            write_json(stage/'metadata.received.json',upstream)
            manifest['metadata_received_path']='metadata.received.json'
            manifest['metadata_received_sha256']=sha(stage/'metadata.received.json')
            manifest['warnings']=[w for w in manifest['warnings'] if 'metadata was not provided' not in w]
        if manifest['location'] is None:manifest['warnings'].append('Camera location unavailable; no coordinates inferred.')
        manifest['coordinate_system']={'origin':'top_left','x':'right','y':'down','bbox':'xyxy_right_bottom_exclusive','frame':'source_rgb_after_exif_orientation'}
        manifest['label_map_path']='label_map.png';manifest['source_rgb_path']='source_rgb.png'
        manifest['class_registry_path']='class_registry.json';manifest['preview_path']='preview_overlay.jpg'
        manifest['quality_status']='prototype_requires_review'
        if self.model_id=='candidate':manifest['warnings'].append('Candidate did not improve held-out validation; do not assume newer is better.')
        write_json(stage/'manifest.json',manifest)
        verify_bundle(stage)
        stage.rename(dest)
        return manifest

def verify_bundle(directory):
    root=Path(directory).resolve();m=read_json(root/'manifest.json')
    def file(relative):
        p=(root/relative).resolve()
        if root not in p.parents or not p.is_file():raise ContractError('INVALID_BUNDLE_PATH',str(relative))
        return p
    if m.get('status')!='ready' or len(m.get('classes',[]))!=14:raise ContractError('INVALID_BUNDLE','Expected ready bundle with 14 classes.')
    rgb=np.array(Image.open(file('source_rgb.png')));labels=np.array(Image.open(file('label_map.png')))
    if labels.shape!=rgb.shape[:2] or not set(np.unique(labels)).issubset(range(15)):raise ContractError('INVALID_BUNDLE','Label shape/IDs invalid.')
    if sha(file(m['source_path']))!=m['source_sha256']:raise ContractError('INVALID_BUNDLE','Source hash mismatch.')
    original,_,_=rgb_source(file(m['source_path']))
    if not np.array_equal(rgb,np.array(original)):raise ContractError('INVALID_BUNDLE','Working RGB differs from oriented source.')
    if {c['id'] for c in m['classes']}!=set(range(1,15)):raise ContractError('INVALID_BUNDLE','Class IDs differ.')
    for c in m['classes']:
        mask=np.array(Image.open(file(c['mask_path'])));clip=np.array(Image.open(file(c['clip_path'])))
        expected=(labels==c['id']).astype('uint8')*255
        if not np.array_equal(mask,expected) or clip.shape!=(*labels.shape,4):raise ContractError('INVALID_BUNDLE','Mask/clip mismatch.')
        if not np.array_equal(clip[:,:,:3],rgb) or not np.array_equal(clip[:,:,3],mask):raise ContractError('INVALID_BUNDLE','RGB/alpha mismatch.')
        count=int((mask>0).sum())
        if count!=c['pixel_count'] or abs(c['area_ratio']-count/mask.size)>1e-12:raise ContractError('INVALID_BUNDLE','Counts differ.')
    if m.get('metadata_original_path'):
        p=file(m['metadata_original_path'])
        if sha(p)!=m['metadata_sha256'] or read_json(p)!=m['upstream_metadata']:raise ContractError('INVALID_BUNDLE','Metadata mismatch.')
    if m.get('metadata_received_path'):
        p=file(m['metadata_received_path'])
        if sha(p)!=m['metadata_received_sha256'] or read_json(p)!=m['upstream_metadata']:raise ContractError('INVALID_BUNDLE','Inline metadata mismatch.')
    return {'verified':True,'sample_id':m['sample_id'],'classes':14,'width':rgb.shape[1],'height':rgb.shape[0]}

def run_request(request_path,output_root,*,model='baseline',device='auto'):
    request_path=Path(request_path).resolve();r=read_json(request_path)
    if not isinstance(r,dict) or r.get('schema_version')!='1.0' or not isinstance(r.get('items'),list) or not r['items']:
        raise ContractError('INVALID_REQUEST','Expected schema_version=1.0 and a nonempty items array.')
    output_root=Path(output_root)
    if output_root.exists():raise ContractError('OUTPUT_EXISTS','Batch output directory must not exist.')
    records=[];seen=set()
    for item in r['items']:
        if not isinstance(item,dict):raise ContractError('INVALID_REQUEST','Each item must be an object.')
        iid=item.get('image_id');check_id(iid)
        if iid.casefold() in seen:raise ContractError('DUPLICATE_IMAGE_ID',iid)
        seen.add(iid.casefold())
        if not isinstance(item.get('image_path'),str):raise ContractError('INVALID_REQUEST','image_path is required.')
        path=validate_image(request_path.parent/item['image_path'])
        mp=request_path.parent/item['metadata_path'] if isinstance(item.get('metadata_path'),str) else None
        if 'metadata_path' in item and mp is None:raise ContractError('INVALID_REQUEST','metadata_path must be a string.')
        resolve_metadata(mp,item.get('metadata'),iid)
        records.append((iid,path,mp,item.get('metadata')))
    engine=Segmenter(model,device)
    output_root.mkdir(parents=True,exist_ok=False)
    (output_root/'request.original.json').write_bytes(request_path.read_bytes())
    result={'schema_version':'1.0','status':'running','model_id':model,'items':[]}
    write_json(output_root/'index.json',result)
    for iid,path,mp,meta in records:
        try:
            m=engine.segment(path,output_root/iid,iid,metadata_path=mp,metadata=meta)
            result['items'].append({'image_id':iid,'status':'ready','manifest_path':iid+'/manifest.json'})
        except Exception as e:
            result['items'].append({'image_id':iid,'status':'failed','error':{'code':getattr(e,'code','PROCESSING_ERROR'),'message':str(e)}})
        write_json(output_root/'index.json',result)
    result['status']='ready' if all(x['status']=='ready' for x in result['items']) else 'partial_failure'
    write_json(output_root/'index.json',result)
    return result
