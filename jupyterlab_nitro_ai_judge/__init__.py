from ._version import __version__
from .handlers import setup_handlers


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "jupyterlab-nitro-ai-judge"}]


def _jupyter_server_extension_points():
    return [{"module": "jupyterlab_nitro_ai_judge"}]


def _load_jupyter_server_extension(server_app):
    setup_handlers(server_app.web_app)
    server_app.log.info("Registered JupyterLab Nitro AI Judge server extension")
