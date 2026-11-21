import argparse,json,sys
from .engine import run_request,verify_bundle

def main():
    p=argparse.ArgumentParser(description='Frozen inference module; no training.')
    sub=p.add_subparsers(dest='command',required=True)
    run=sub.add_parser('run');run.add_argument('--request',required=True);run.add_argument('--output',required=True)
    run.add_argument('--model',choices=['baseline','candidate'],default='baseline');run.add_argument('--device',choices=['auto','cpu','cuda'],default='auto')
    verify=sub.add_parser('verify');verify.add_argument('--bundle',required=True)
    a=p.parse_args()
    try:
        result=run_request(a.request,a.output,model=a.model,device=a.device) if a.command=='run' else verify_bundle(a.bundle)
        print(json.dumps(result,ensure_ascii=False));return 0 if result.get('status')!='partial_failure' else 3
    except Exception as e:
        print(json.dumps({'status':'failed','error':{'code':getattr(e,'code','PROCESSING_ERROR'),'message':str(e)}},ensure_ascii=False));return 2

if __name__=='__main__':sys.exit(main())
