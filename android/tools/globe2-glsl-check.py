#!/usr/bin/env python3
# CPU-only GLSL ES 3.00 compile + link check of exported world shader stages (lane NG, GLOBE-NATIVE-PLAN §8).
#
#   python3 tools/globe2-glsl-check.py renderer/src/test/resources/world/globe2/shaders renderer/src/main/resources/world/shaders
#
# Every <name>.vs.glsl / <name>.fs.glsl pair in the given directories is compiled and linked by the Android emulator's
# bundled SwiftShader GLES frontend (emulator/lib64/gles_angle/libswiftshader_lib{EGL,GLESv2}.dylib: SwiftShader's
# Reactor/LLVM JIT, a CPU renderer) on a 16x16 pbuffer. It never loads ANGLE's libEGL/libGLESv2 (which could pick a
# Metal backend) and never touches the Mac GPU (D-168.3); no emulator is booted. What it proves: the stages are valid
# GLSL ES 3.00 that a real compiler accepts and links (it caught int/float mix-ups the string rules cannot). What it
# does not prove: Mali's compiler, precision behaviour (SwiftShader ignores mediump) or anything about speed.
# Exit 1 on any failure.
import ctypes, sys, os, glob
LIB = os.path.expanduser('~/.bubblewrap/android_sdk/emulator/lib64/gles_angle')
egl = ctypes.CDLL(os.path.join(LIB, 'libswiftshader_libEGL.dylib'))
gl = ctypes.CDLL(os.path.join(LIB, 'libswiftshader_libGLESv2.dylib'))
V = ctypes.c_void_p
egl.eglGetDisplay.restype = V; egl.eglGetDisplay.argtypes = [V]
egl.eglInitialize.argtypes = [V, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
egl.eglChooseConfig.argtypes = [V, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(V), ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
egl.eglCreatePbufferSurface.restype = V; egl.eglCreatePbufferSurface.argtypes = [V, V, ctypes.POINTER(ctypes.c_int)]
egl.eglCreateContext.restype = V; egl.eglCreateContext.argtypes = [V, V, V, ctypes.POINTER(ctypes.c_int)]
egl.eglMakeCurrent.argtypes = [V, V, V, V]
egl.eglBindAPI.argtypes = [ctypes.c_uint]
EGL_NONE=0x3038
d = egl.eglGetDisplay(None)
maj, mnr = ctypes.c_int(), ctypes.c_int()
assert egl.eglInitialize(d, ctypes.byref(maj), ctypes.byref(mnr)), 'eglInitialize'
egl.eglBindAPI(0x30A0)
attrs = (ctypes.c_int * 11)(0x3040, 0x40, 0x3033, 0x1, 0x3024, 8, 0x3023, 8, 0x3022, 8, EGL_NONE)  # RENDERABLE_TYPE=ES3, SURFACE_TYPE=PBUFFER, RGB8
cfg = V(); n = ctypes.c_int()
assert egl.eglChooseConfig(d, attrs, ctypes.byref(cfg), 1, ctypes.byref(n)) and n.value > 0, 'no ES3 pbuffer config'
surf = egl.eglCreatePbufferSurface(d, cfg, (ctypes.c_int * 5)(0x3057, 16, 0x3056, 16, EGL_NONE))
ctx = egl.eglCreateContext(d, cfg, None, (ctypes.c_int * 3)(0x3098, 3, EGL_NONE))
assert ctx and egl.eglMakeCurrent(d, surf, surf, ctx), 'no ES3 context'
gl.glGetString.restype = ctypes.c_char_p
print('GL', gl.glGetString(0x1F02).decode(), '|', gl.glGetString(0x1F01).decode())
def shader(kind, src):
    s = gl.glCreateShader(kind)
    b = ctypes.c_char_p(src.encode()); gl.glShaderSource(s, 1, ctypes.byref(b), None); gl.glCompileShader(s)
    ok = ctypes.c_int(); gl.glGetShaderiv(s, 0x8B81, ctypes.byref(ok))
    log = ctypes.create_string_buffer(8192); gl.glGetShaderInfoLog(s, 8192, None, log)
    return s, ok.value, log.value.decode(errors='replace')
bad = 0
for d_ in sys.argv[1:]:
    for vsf in sorted(glob.glob(os.path.join(d_, '*.vs.glsl'))):
        name = os.path.basename(vsf)[:-8]; fsf = vsf[:-8] + '.fs.glsl'
        vs, okv, lv = shader(0x8B31, open(vsf).read()); fs, okf, lf = shader(0x8B30, open(fsf).read())
        linked = 0; ll = ''
        if okv and okf:
            p = gl.glCreateProgram(); gl.glAttachShader(p, vs); gl.glAttachShader(p, fs); gl.glLinkProgram(p)
            ok = ctypes.c_int(); gl.glGetProgramiv(p, 0x8B82, ctypes.byref(ok)); linked = ok.value
            log = ctypes.create_string_buffer(8192); gl.glGetProgramInfoLog(p, 8192, None, log); ll = log.value.decode(errors='replace')
        status = 'OK' if (okv and okf and linked) else 'FAIL'
        if status == 'FAIL': bad += 1
        print(f'{status} {name}: vs={okv} fs={okf} link={linked}')
        for l in (lv, lf, ll):
            if l.strip(): print('   ', l.strip()[:1500])
sys.exit(1 if bad else 0)
