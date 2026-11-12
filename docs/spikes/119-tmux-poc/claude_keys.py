import os, pty, sys, time, subprocess, select, fcntl, termios, struct
TMUX=sys.argv[1]; D=os.path.dirname(os.path.abspath(__file__)); S='poc119c'
def t(*a): return subprocess.run([TMUX,'-L',S,*a],capture_output=True,text=True).stdout
subprocess.run([TMUX,'-L',S,'kill-server'],stderr=subprocess.DEVNULL)
pid,fd=pty.fork()
if pid==0:
    os.environ['TERM']='xterm-ghostty'; pass
    os.execvp(TMUX,[TMUX,'-L',S,'-f',f'{D}/tmux.conf','new-session','-s','w','claude'])
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',50,160,0,0))
def pump(x):
    end=time.time()+x
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.1)
        if r:
            try: os.read(fd,65536)
            except OSError: return
pump(8)
print(t('capture-pane','-p','-t','w')[-600:])
for name,k in (('type A',b'AAA'),('Shift+Enter (mok)',b'\x1b[27;2;13~'),('type B',b'BBB'),('Ctrl+Enter (mok)',b'\x1b[27;5;13~'),('type C',b'CCC')):
    os.write(fd,k); pump(1)
    cap=[l for l in t('capture-pane','-p','-t','w').splitlines() if l.strip()]
    print('--',name); print('\n'.join(cap[-8:]))
subprocess.run([TMUX,'-L',S,'kill-server'],stderr=subprocess.DEVNULL)
