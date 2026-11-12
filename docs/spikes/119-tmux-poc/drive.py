import os, pty, sys, time, subprocess, select
TMUX = sys.argv[1]; D = os.path.dirname(os.path.abspath(__file__))
def run(mode, keys, label, size=(220,60)):
    out = f'{D}/{mode}.out'
    subprocess.run([TMUX,'-L','poc119','kill-server'],stderr=subprocess.DEVNULL)
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM']='xterm-ghostty'
        os.execvp(TMUX,[TMUX,'-L','poc119','-f',f'{D}/tmux.conf','new-session','-s','workspaces','python3',f'{D}/reader.py',mode,out])
    import fcntl, termios, struct
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH',size[1],size[0],0,0))
    buf=b''
    def pump(t):
        nonlocal buf
        end=time.time()+t
        while time.time()<end:
            r,_,_=select.select([fd],[],[],0.1)
            if r:
                try: buf+=os.read(fd,65536)
                except OSError: return
    pump(2)
    for k in keys:
        os.write(fd,k); pump(0.4)
    pump(1)
    print(label, 'client init sequences:', [s for s in (b'\x1b[>4;2m',b'\x1b[>4;1m',b'\x1b[>1u',b'\x1b[=') if s in buf])
    print(open(out).read())
    os.kill(pid,9) if False else None
    subprocess.run([TMUX,'-L','poc119','kill-server'],stderr=subprocess.DEVNULL)
S_ENTER_MOK=b'\x1b[27;2;13~'; C_ENTER_MOK=b'\x1b[27;5;13~'
S_ENTER_U=b'\x1b[13;2u'; C_ENTER_U=b'\x1b[13;5u'
for mode in ('none','mok','kitty'):
    print('== app mode', mode, '(outer keys: shift+enter, ctrl+enter as modifyOtherKeys then csi-u)')
    run(mode,[S_ENTER_MOK,C_ENTER_MOK,S_ENTER_U,C_ENTER_U,b'\r'],mode)
print('== mouse')
run('mouse',[b'\x1b[<0;100;10M',b'\x1b[<0;100;10m',b'\x1b[<0;5;10M',b'\x1b[<64;100;10M'],'mouse')
