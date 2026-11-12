import sys, os, tty, termios, time
mode = sys.argv[1]; out = sys.argv[2]
tty.setraw(0)
if mode == 'mok': sys.stdout.write('\x1b[>4;2m')
if mode == 'kitty': sys.stdout.write('\x1b[>1u')
if mode == 'mouse': sys.stdout.write('\x1b[?1000h\x1b[?1006h')
sys.stdout.flush()
open(out,'w').write('ready\n')
end = time.time()+8
while time.time() < end:
    import select
    r,_,_ = select.select([0],[],[],0.2)
    if r:
        d = os.read(0,64)
        open(out,'a').write(d.hex()+'\n')
