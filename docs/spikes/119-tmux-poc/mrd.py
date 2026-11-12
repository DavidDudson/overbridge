import os,sys,tty,time,select
tty.setraw(0); sys.stdout.write('\x1b[?1000h\x1b[?1006h'); sys.stdout.flush()
end=time.time()+6
while time.time()<end:
    r,_,_=select.select([0],[],[],.2)
    if r: open('mouse.out','a').write(os.read(0,64).hex()+'\n')
