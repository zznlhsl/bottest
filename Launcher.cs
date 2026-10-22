using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;

class Program {
    static void Main() {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string serverJs = Path.Combine(dir, "server.js");

        bool isRunning = false;
        try {
            using (var client = new TcpClient("127.0.0.1", 4567)) {
                isRunning = true;
            }
        } catch {}

        if (!isRunning) {
            ProcessStartInfo psi = new ProcessStartInfo {
                FileName = "node.exe",
                Arguments = "\"" + serverJs + "\"",
                WorkingDirectory = dir,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            try {
                Process.Start(psi);
                Thread.Sleep(1500);
            } catch {
                Process.Start("cmd.exe", "/c start /b node \"" + serverJs + "\"");
                Thread.Sleep(1500);
            }
        }

        try {
            Process.Start(new ProcessStartInfo {
                FileName = "http://127.0.0.1:4567",
                UseShellExecute = true
            });
        } catch {}
    }
}
