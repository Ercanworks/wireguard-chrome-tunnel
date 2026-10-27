"""
Windows service wrapper for vpn_api. Installs as WireGuardAPIService.

Install:  python wireguard_service.py install
Start:    python wireguard_service.py start
Stop:     python wireguard_service.py stop
Remove:   python wireguard_service.py remove
"""

import os
import sys
import threading

import servicemanager
import win32event
import win32service
import win32serviceutil


class WireGuardAPIService(win32serviceutil.ServiceFramework):
    _svc_name_ = "WireGuardAPIService"
    _svc_display_name_ = "WG Chrome Manager API"
    _svc_description_ = "Local API + userspace WireGuard (wireproxy) for the Chrome extension."

    def __init__(self, args):
        win32serviceutil.ServiceFramework.__init__(self, args)
        self.hWaitStop = win32event.CreateEvent(None, 0, 0, None)
        self.thread = None

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        # Don't leave wireproxy orphaned holding the SOCKS port.
        try:
            import vpn_api
            vpn_api.shutdown()
        except Exception:
            pass
        win32event.SetEvent(self.hWaitStop)

    def SvcDoRun(self):
        servicemanager.LogInfoMsg("WG Chrome Manager API starting...")
        here = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, here)

        def run_app():
            try:
                import vpn_api
                vpn_api.start_api()
            except Exception as e:
                servicemanager.LogErrorMsg(f"API crashed: {e}")

        self.thread = threading.Thread(target=run_app, daemon=True)
        self.thread.start()
        win32event.WaitForSingleObject(self.hWaitStop, win32event.INFINITE)


if __name__ == "__main__":
    win32serviceutil.HandleCommandLine(WireGuardAPIService)
