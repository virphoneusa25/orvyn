// Non-elevated, private stdin/stdout helper. No network listener or shell execution.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;

class WindowsDesktop {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
  [StructLayout(LayoutKind.Explicit)] struct UNION {
    [FieldOffset(0)] public MOUSE mouse;
    [FieldOffset(0)] public KEY key;
  }
  [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f,IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flag);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
  [DllImport("user32.dll")] static extern uint SendInput(uint n,INPUT[] inputs,int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h,int index,StringBuilder name,int size,out int needed);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr h,uint access,out IntPtr token);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr h,int cls,out int value,int size,out int length);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength=12000000 };
  static string S(Dictionary<string,object> d,string k) { return d.ContainsKey(k) ? Convert.ToString(d[k]) : ""; }
  static int N(Dictionary<string,object> d,string k) { return Convert.ToInt32(d[k]); }
  static bool SafeProcess(Process p) {
    string name=p.ProcessName.ToLowerInvariant();
    // Shells, security prompts, password managers and ORVYN itself are never targets.
    foreach(string deny in new[]{"orvyn","codex","powershell","pwsh","cmd","windowsterminal","consent","credential","keepass","1password","bitwarden","logonui","taskmgr","regedit","mmc","wscript","cscript"})
      if(name.Contains(deny)) return false;
    IntPtr token;
    if(!OpenProcessToken(p.Handle,8,out token)) return false;
    try { int elevated,len; return GetTokenInformation(token,20,out elevated,4,out len) && elevated==0; }
    finally { CloseHandle(token); }
  }
  static Dictionary<string,object> Describe(IntPtr h) {
    if(!IsWindowVisible(h) || IsIconic(h)) throw new Exception("Window is not visible.");
    var title=new StringBuilder(512); GetWindowText(h,title,512);
    if(title.Length==0) throw new Exception("Untitled window.");
    uint pid; GetWindowThreadProcessId(h,out pid);
    using(var p=Process.GetProcessById((int)pid)) {
      if(!SafeProcess(p)) throw new Exception("Protected or elevated application.");
      return new Dictionary<string,object> { {"handle",h.ToInt64().ToString()}, {"pid",pid}, {"started",p.StartTime.ToUniversalTime().Ticks.ToString()}, {"title",title.ToString()}, {"path",p.MainModule.FileName} };
    }
  }
  static void DesktopSafe() {
    IntPtr desk=OpenInputDesktop(0,false,1);
    if(desk==IntPtr.Zero) throw new Exception("Interactive desktop unavailable.");
    try { var name=new StringBuilder(256); int needed;
      if(!GetUserObjectInformation(desk,2,name,512,out needed) || !String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase)) throw new Exception("Secure desktop is blocked.");
    } finally { CloseDesktop(desk); }
  }
  static void Send(INPUT[] inputs) {
    if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(INPUT)))!=inputs.Length) throw new Exception("Windows rejected the input.");
  }
  static INPUT Key(ushort vk,ushort scan,uint flags) { return new INPUT { type=1,data=new UNION {key=new KEY {vk=vk,scan=scan,flags=flags}}}; }
  static object Act(Dictionary<string,object> d) {
    if(S(d,"token")!=Environment.GetEnvironmentVariable("ORVYN_NATIVE_TOKEN")) throw new Exception("Invalid helper session.");
    DesktopSafe();
    string action=S(d,"action");
    if(action=="windows") {
      var windows=new List<object>();
      EnumWindows(delegate(IntPtr h,IntPtr unused) { try { windows.Add(Describe(h)); } catch {} return windows.Count<100; },IntPtr.Zero);
      return new {ok=true,windows=windows};
    }
    long expiry=Convert.ToInt64(d["expiresAt"]);
    long now=(long)(DateTime.UtcNow-new DateTime(1970,1,1)).TotalMilliseconds;
    if(expiry<=now || expiry>now+301000) throw new Exception("Permission expired.");
    IntPtr target=new IntPtr(Int64.Parse(S(d,"handle")));
    var identity=Describe(target);
    if(S(identity,"started")!=S(d,"started") || S(identity,"pid")!=S(d,"pid") || !String.Equals(S(identity,"path"),S(d,"path"),StringComparison.OrdinalIgnoreCase)) throw new Exception("The selected application changed.");
    RECT r; if(!GetWindowRect(target,out r) || r.R-r.L<=0 || r.B-r.T<=0 || r.R-r.L>8192 || r.B-r.T>8192) throw new Exception("Unsupported window bounds.");
    if(action=="screenshot") {
      using(var bitmap=new Bitmap(r.R-r.L,r.B-r.T)) using(var graphics=Graphics.FromImage(bitmap)) {
        var dc=graphics.GetHdc(); bool captured;
        try { captured=PrintWindow(target,dc,2); } finally {graphics.ReleaseHdc(dc);}
        if(!captured) throw new Exception("This application does not support private window capture.");
        using(var stream=new MemoryStream()) { bitmap.Save(stream,ImageFormat.Png);
          if(stream.Length>6000000) throw new Exception("Window image is too large.");
          return new {ok=true,screenshot=new {b64=Convert.ToBase64String(stream.ToArray()),mediaType="image/png"},width=bitmap.Width,height=bitmap.Height,output="Selected window captured. Coordinates are relative to this image."};
        }
      }
    }
    if(action=="inspect") {
      var items=new List<object>(); var queue=new Queue<AutomationElement>(); queue.Enqueue(AutomationElement.FromHandle(target));
      while(queue.Count>0 && items.Count<150) {
        var el=queue.Dequeue(); var c=el.Current;
        items.Add(new {name=c.IsPassword ? "[private]" : c.Name.Substring(0,Math.Min(c.Name.Length,160)),type=c.ControlType.ProgrammaticName,password=c.IsPassword});
        if(c.IsPassword) continue;
        var child=TreeWalker.ControlViewWalker.GetFirstChild(el);
        while(child!=null && queue.Count<200) {queue.Enqueue(child);child=TreeWalker.ControlViewWalker.GetNextSibling(child);}
      }
      return new {ok=true,output=json.Serialize(items)};
    }
    if(action=="focus") return new {ok=SetForegroundWindow(target),output="Selected window focused."};
    if(GetForegroundWindow()!=target) throw new Exception("Bring the selected window to the foreground before approving input.");
    foreach(int modifier in new[]{16,17,18,91,92}) if((GetAsyncKeyState(modifier)&0x8000)!=0) throw new Exception("Release keyboard modifiers before input.");
    if(action=="move" || action=="click") {
      int x=N(d,"x"),y=N(d,"y");
      if(x<0 || y<0 || x>=r.R-r.L || y>=r.B-r.T) throw new Exception("Point is outside the selected window.");
      var point=new POINT {X=r.L+x,Y=r.T+y};
      if(GetAncestor(WindowFromPoint(point),2)!=target) throw new Exception("Another window covers this point.");
      if(!SetCursorPos(point.X,point.Y)) throw new Exception("Cursor movement rejected.");
      if(GetForegroundWindow()!=target || GetAncestor(WindowFromPoint(point),2)!=target) throw new Exception("Window changed before input.");
      if(action=="click") Send(new[]{new INPUT {data=new UNION {mouse=new MOUSE {flags=2}}},new INPUT {data=new UNION {mouse=new MOUSE {flags=4}}}});
    } else if(action=="type") {
      string text=S(d,"text"); if(text.Length>1000) throw new Exception("Text exceeds 1000 characters.");
      foreach(char ch in text) {
        if(GetForegroundWindow()!=target) throw new Exception("Window focus changed; typing stopped.");
        Send(new[]{Key(0,ch,4),Key(0,ch,6)});
      }
    } else if(action=="key") {
      var keys=new Dictionary<string,ushort> {{"Enter",13},{"Tab",9},{"Escape",27},{"Backspace",8},{"Delete",46},{"Left",37},{"Right",39},{"Up",38},{"Down",40},{"Home",36},{"End",35},{"PageUp",33},{"PageDown",34}};
      if(!keys.ContainsKey(S(d,"key"))) throw new Exception("Unsupported key. System shortcuts are blocked.");
      ushort vk=keys[S(d,"key")]; Send(new[]{Key(vk,0,0),Key(vk,0,2)});
    } else if(action=="scroll") {
      POINT point; if(!GetCursorPos(out point) || GetAncestor(WindowFromPoint(point),2)!=target) throw new Exception("Place the pointer over the approved window before scrolling.");
      int delta=N(d,"delta"); if(Math.Abs((long)delta)>1200) throw new Exception("Scroll exceeds limit.");
      Send(new[]{new INPUT {data=new UNION {mouse=new MOUSE {flags=0x800,data=unchecked((uint)delta)}}}});
    } else throw new Exception("Unknown desktop action.");
    return new {ok=true,output="Selected window: "+action};
  }
  [STAThread] static void Main() {
    if(String.IsNullOrEmpty(Environment.GetEnvironmentVariable("ORVYN_NATIVE_TOKEN"))) return;
    SetProcessDPIAware(); string line;
    while((line=Console.ReadLine())!=null) {
      object result; string id="";
      try { if(line.Length>16000) throw new Exception("Request too large."); var d=json.Deserialize<Dictionary<string,object>>(line); id=S(d,"id"); result=Act(d); }
      catch(Exception e) {result=new {ok=false,error=e.Message};}
      Console.WriteLine(json.Serialize(new {id=id,result=result}));
    }
  }
}
