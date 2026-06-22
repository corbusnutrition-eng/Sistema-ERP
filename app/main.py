"""
Punto de entrada si ejecutas ``uvicorn app.main:app`` desde la **raíz** del repo.

El ERP completo está en ``backend/app/``. Hay otra carpeta ``app/`` aquí (stubs legacy);
esta misma ruta delega al FastAPI real para evitar 404 en ``/api/v1/users``, etc.
"""

from __future__ import annotations

import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
_ERP_MAIN_FILE = _BACKEND_DIR / "app" / "main.py"
_STUB_APP_DIR = Path(__file__).resolve().parent


def _delegate_to_backend_erp() -> object:
    if not _ERP_MAIN_FILE.is_file():
        raise RuntimeError(
            "No se encuentra backend/app/main.py. Arranca desde la carpeta backend: "
            "`cd backend && uvicorn app.main:app --reload`."
        )

    backend_root = _BACKEND_DIR.resolve()
    if str(backend_root) not in sys.path:
        sys.path.insert(0, str(backend_root))

    # Quitar módulos del stub en repo/app/ (no borrar app.main: estamos cargándolo ahora).
    stub = _STUB_APP_DIR.resolve()
    for name in list(sys.modules.keys()):
        if name == "app.main":
            continue
        if name != "app" and not name.startswith("app."):
            continue
        mod = sys.modules.get(name)
        fp = getattr(mod, "__file__", None)
        if not fp:
            continue
        try:
            if Path(fp).resolve().is_relative_to(stub):
                del sys.modules[name]
        except ValueError:
            pass

    if "app" in sys.modules:
        pkg = sys.modules["app"]
        paths = getattr(pkg, "__path__", None) or []
        if paths and any(Path(p).resolve() == stub for p in paths):
            del sys.modules["app"]

    spec = spec_from_file_location("_erp_loaded_main_", _ERP_MAIN_FILE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"No se pudo cargar el módulo FastAPI desde {_ERP_MAIN_FILE}")
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.app


app = _delegate_to_backend_erp()
