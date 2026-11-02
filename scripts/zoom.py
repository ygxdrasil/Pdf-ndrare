import sys
from PIL import Image
# zoom.py preview.jpg out.png x0 y0 x1 y1 scale   (image px of the picture)
src,dst,x0,y0,x1,y1,sc=sys.argv[1],sys.argv[2],*map(float,sys.argv[3:8])
im=Image.open(src).crop((int(x0),int(y0),int(x1),int(y1)))
im=im.resize((int(im.width*sc),int(im.height*sc)),Image.NEAREST); im.save(dst)
