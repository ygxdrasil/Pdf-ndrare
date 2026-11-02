import sys
from PIL import Image
# crop.py in.png out.png x0 y0 x1 y1  (image px of the page picture), render dpi via arg
src,dst,x0,y0,x1,y1,dpi=sys.argv[1],sys.argv[2],*map(float,sys.argv[3:8])
k=dpi/72; a=0.503739; oy=60.75
im=Image.open(src)
im.crop((int(a*x0*k),int((oy+a*y0)*k),int(a*x1*k),int((oy+a*y1)*k))).save(dst)
