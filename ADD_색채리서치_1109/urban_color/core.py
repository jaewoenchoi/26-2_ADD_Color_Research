from __future__ import annotations
import hashlib,json,shutil
from pathlib import Path
from datetime import datetime,timezone
import numpy as np
from PIL import Image,ImageOps
import torch
from torch.nn import functional as F


MEAN = torch.tensor([.485, .456, .406])[:, None, None]

STD = torch.tensor([.229, .224, .225])[:, None, None]

PALETTE = np.array([[0,0,0],[230,110,40],[140,80,200],[110,170,90],
 [190,120,80],[220,170,180],[125,125,125],[160,90,50],[120,170,180],
 [240,210,40],[90,180,250],[220,70,110],[50,170,70],[190,175,150],[40,90,240]], dtype=np.uint8)

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def write_json(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')

def rgb_source(path):
    with Image.open(path) as raw:
        if raw.mode != 'RGB':
            raise ValueError(f'Expected 8-bit RGB input, got {raw.mode}: {path}')
        orientation = raw.getexif().get(274, 1)
        original_size = list(raw.size)
        profile = raw.info.get('icc_profile')
        rgb = ImageOps.exif_transpose(raw).copy()
    return rgb, profile, {'exif_orientation': orientation, 'original_size': original_size,
                          'working_size': list(rgb.size), 'coordinate_frame': 'exif_transposed',
                          'icc_profile_preserved': bool(profile)}

def preprocess(rgb, size, mask=None):
    w,h = rgb.size
    scale = size / max(w,h)
    nw,nh = max(1, round(w*scale)), max(1, round(h*scale))
    left,top = (size-nw)//2, (size-nh)//2
    a = np.asarray(rgb.resize((nw,nh), Image.Resampling.BILINEAR)).copy()
    small = (torch.from_numpy(a).permute(2,0,1).float()/255-MEAN)/STD
    tensor = torch.zeros(3,size,size)
    tensor[:,top:top+nh,left:left+nw] = small
    geom = {'resized_width':nw, 'resized_height':nh, 'left':left, 'top':top, 'size':size}
    if mask is None:
        return tensor, geom
    target = torch.full((size,size),255,dtype=torch.long)
    resized = np.asarray(mask.resize((nw,nh), Image.Resampling.NEAREST)).copy()
    target[top:top+nh,left:left+nw] = torch.from_numpy(resized.astype(np.int64))
    return tensor, target

@torch.inference_mode()
def predict(model, rgb, size, device):
    x,g=preprocess(rgb,size); logits=model(x[None].to(device))['out']
    logits=F.interpolate(logits,size=(size,size),mode='bilinear',align_corners=False)
    t,l,h,w=g['top'],g['left'],g['resized_height'],g['resized_width']
    logits=logits[:,:,t:t+h,l:l+w]
    # Interpolate one class at a time to avoid a full-resolution 15-channel GPU allocation.
    best=np.full((rgb.height,rgb.width),-np.inf,dtype=np.float32)
    labels=np.zeros(best.shape,dtype=np.uint8)
    for c in range(15):
        score=F.interpolate(logits[:,c:c+1],size=best.shape,mode='bilinear',align_corners=False)[0,0].cpu().numpy()
        take=score>best; best[take]=score[take]; labels[take]=c
    return labels,g

def export_bundle(source, labels, destination, registry, provenance, metadata=None):
    source=Path(source); destination=Path(destination)
    if destination.exists(): raise FileExistsError(destination)
    temp=destination.with_name(destination.name+'.partial');temp.mkdir(parents=True,exist_ok=False)
    rgb,profile,geometry=rgb_source(source); arr=np.asarray(rgb)
    assert labels.shape==arr.shape[:2] and set(np.unique(labels)).issubset(set(range(15)))
    opts={'icc_profile':profile} if profile else {}
    for sub in ['original','masks','clips']: (temp/sub).mkdir()
    shutil.copy2(source,temp/'original'/source.name)
    rgb.save(temp/'source_rgb.png',**opts);Image.fromarray(labels).save(temp/'label_map.png')
    upstream=None
    if metadata is not None:
        upstream=json.loads(Path(metadata).read_text(encoding='utf-8-sig'))
        shutil.copy2(metadata,temp/'metadata.original.json')
        assert sha(metadata)==sha(temp/'metadata.original.json')
    classes=[]
    for c in registry['classes']:
        if not c['export']:continue
        k=c['train_id']; mask=(labels==k); n=int(mask.sum())
        stem=f'{k:02d}_{c["name"]}.png'
        mask_path='masks/'+stem; clip_path='clips/'+stem
        binary=(mask.astype(np.uint8)*255)
        Image.fromarray(binary).save(temp/mask_path)
        rgba=np.dstack([arr,binary]);Image.fromarray(rgba).save(temp/clip_path,**opts)
        ys,xs=np.where(mask)
        classes.append({'id':k,'name':c['name'],'status':'predicted_present' if n else 'supported_absent',
            'pixel_count':n,'area_ratio':n/mask.size,'bbox_xyxy':[int(xs.min()),int(ys.min()),int(xs.max()+1),int(ys.max()+1)] if n else None,
            'mask_path':mask_path,'clip_path':clip_path})
        # Check actual reloaded PNG bytes, not just the arrays used to write them.
        loaded=np.array(Image.open(temp/clip_path));bm=np.array(Image.open(temp/mask_path))
        assert np.array_equal(loaded[:,:,:3],arr) and np.array_equal(loaded[:,:,3],bm)
        assert np.array_equal(bm,binary) and set(np.unique(bm)).issubset({0,255})
    preview=arr.copy(); fg=labels>0
    preview[fg]=(arr[fg]*.58+PALETTE[labels[fg]]*.42).astype(np.uint8)
    overlay=Image.fromarray(preview);overlay.thumbnail((1200,1200));overlay.save(temp/'preview_overlay.jpg',quality=90)
    write_json(temp/'class_registry.json',registry)
    assert sha(source)==sha(temp/'original'/source.name)
    assert len(list((temp/'masks').glob('*.png')))==14==len(list((temp/'clips').glob('*.png')))
    assert sum(c['pixel_count'] for c in classes)+int((labels==0).sum())==labels.size
    manifest={'schema_version':'1.0','sample_id':source.stem,'created_at':datetime.now(timezone.utc).isoformat(),
        'status':'ready','source_path':'original/'+source.name,'source_sha256':sha(source),
        'metadata_status':'provided' if metadata else 'not_provided','upstream_metadata':upstream,
        'location':upstream.get('location') if isinstance(upstream,dict) else None,
        'metadata_original_path':'metadata.original.json' if metadata else None,
        'metadata_sha256':sha(metadata) if metadata else None,
        'geometry':geometry,'provenance':provenance,'classes':classes,
        'background_pixels':int((labels==0).sum()),
        'warnings':['Prototype trained on a small dataset; validate masks before color analysis.']+([] if metadata else ['Location metadata was not provided; no coordinates inferred.']),
        'verification':{'rgb_equals_source':True,'alpha_equals_mask':True,'original_hash_preserved':True,'class_files':14}}
    write_json(temp/'manifest.json',manifest)
    temp.rename(destination)
    return manifest
