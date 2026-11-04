#!/usr/bin/env python3
"""Edit a genuine browser recording, shortening only identified model waits.
Requires ffmpeg/ffprobe and Pillow. Never calls a model or replaces UI content.
Usage: python3 scripts/build-demo.py RAW.webm ACTIONS.json OUTPUT.mp4
"""
import hashlib, json, pathlib, subprocess, sys, textwrap
from PIL import Image, ImageDraw, ImageFont
raw, actions, output = map(pathlib.Path, sys.argv[1:4])
record = json.loads(actions.read_text())
marks = {row['action']: row['elapsedSeconds'] for row in record['logs']}
if 'walkthrough_passed' not in marks:
    raise SystemExit('Refusing to publish a failed walkthrough')
duration = float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(raw)]))
work = output.parent / (output.stem + '-edit')
work.mkdir(parents=True, exist_ok=True)
font_paths = ['/System/Library/Fonts/Supplemental/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
def font(size):
    for path in font_paths:
        if pathlib.Path(path).exists(): return ImageFont.truetype(path,size)
    return ImageFont.load_default(size=size)
segments=[]
def add(start,end,speed,caption):
    start=max(0,start);end=min(duration,end)
    if end>start: segments.append({'start':start,'end':end,'speed':speed,'caption':caption})
a=marks['sample_pipeline_started']; b=marks['sample_pipeline_finished']; c=marks['live_simulation_started']; d=marks['live_simulation_finished']; e=marks['sell_acceptance_survived_reload']; f=marks['find_qualification_started']; g=marks['find_qualification_finished']; h=marks['find_acceptance_survived_reload']
add(0,a+2,1,'Offload: one photo, an honest listing, and owner-controlled decisions.')
add(a+2,b-1,10,'Real Meta processing. This waiting interval is shown at 10x speed.')
add(b-1,c+2,1,'Original, cutout and hero. Visible wear stays; unknown facts go to the owner.')
add(c+2,d-1,10,'Five simulated buyers test the live agent. This waiting interval is shown at 10x.')
add(d-1,e+1,1,'A qualified offer becomes a Yes / No decision. Acceptance survives reload.')
add(e+1,f+2,1,'Find: describe a need, then manually enter a seller offer. No marketplace search.')
add(f+2,g-1,6,'Checking the item, budget, currency, condition and pickup. Waiting shown at 6x.')
add(g-1,min(h+3,duration),1,'A matching offer becomes a decision. The saved acceptance survives reload.')
parts=[]
for i, segment in enumerate(segments):
    banner=Image.new('RGB',(1280,110),'#242b24'); draw=ImageDraw.Draw(banner)
    lines=textwrap.wrap(segment['caption'],width=88)
    for j,line in enumerate(lines[:2]):draw.text((24,12+j*30),line,font=font(25),fill='#fffdf4')
    draw.text((24,83),'Real APIs | Synthetic sample photo | Simulated buyers | Waits accelerated | No external trade',font=font(17),fill='#d5d0bd')
    png=work/f'caption-{i:02}.png';banner.save(png)
    part=work/f'part-{i:02}.mp4';parts.append(part)
    command=['ffmpeg','-hide_banner','-loglevel','error','-y','-ss',str(segment['start']),'-t',str(segment['end']-segment['start']),'-i',str(raw),'-loop','1','-i',str(png),'-filter_complex',f'[0:v]setpts=(PTS-STARTPTS)/{segment["speed"]},pad=1280:910:0:0:color=0x242b24[v];[v][1:v]overlay=0:800:shortest=1,format=yuv420p[out]','-map','[out]','-an','-r','25','-c:v','libx264','-preset','veryfast','-crf','22','-threads','2','-filter_complex_threads','2',str(part)]
    subprocess.run(command,check=True)
    print(f'Rendered segment {i+1}/{len(segments)}',flush=True)
concat=work/'concat.txt';concat.write_text(''.join("file '"+str(p.resolve()).replace("'","'\\''")+"'\n" for p in parts))
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',str(concat),'-c','copy','-movflags','+faststart',str(output)],check=True)
manifest={'sourceUrl':record['url'],'sourceSha256':hashlib.sha256(raw.read_bytes()).hexdigest(),'outputSha256':hashlib.sha256(output.read_bytes()).hexdigest(),'sourceDuration':duration,'segments':segments,'audio':False,'notes':'Only model-wait intervals are accelerated. Captions are editorial overlays; UI is actual captured browser footage.'}
output.with_suffix('.timeline.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'output':str(output),'bytes':output.stat().st_size,'segments':len(segments)}),flush=True)
