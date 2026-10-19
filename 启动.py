"""Start the local service and open its browser workspace."""
from pathlib import Path
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get('XUNZHAO_PORT', '8770'))
if not 1 <= PORT <= 65535:
    raise SystemExit('服务端口需要在 1 到 65535 之间。')
URL = f'http://127.0.0.1:{PORT}/'


def ready():
    try:
        with urllib.request.urlopen(URL + 'api/status', timeout=1) as response:
            status = json.load(response)
            return status.get('version') == 7 and status.get('application') == 'xunzhao'
    except (OSError, ValueError, urllib.error.URLError):
        return False


def open_workspace():
    if os.environ.get('XUNZHAO_NO_BROWSER') != '1':
        subprocess.run(['/usr/bin/open', URL], check=False)


def main():
    if ready():
        open_workspace()
        print('客户档案已运行：' + URL, flush=True)
        return
    process = subprocess.Popen([sys.executable, str(ROOT / 'server.py'), '--port', str(PORT)], cwd=str(ROOT))
    try:
        for _ in range(120):
            if process.poll() is not None:
                raise SystemExit('服务没有启动，请检查上方提示和端口是否被占用。')
            if ready():
                open_workspace()
                print('保持这个窗口打开，即可使用客户档案：' + URL, flush=True)
                break
            time.sleep(.5)
        else:
            raise SystemExit('服务尚未就绪，请检查端口或稍后重试。')
        process.wait()
    except KeyboardInterrupt:
        pass
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == '__main__':
    main()
