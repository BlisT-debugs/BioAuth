import os

from app import app, init_db


def create_app():
    """
    WSGI entrypoint for production servers (gunicorn, uWSGI, etc.).
    Ensures the database is initialized before serving requests.
    """
    with app.app_context():
        init_db()
    return app


# For WSGI servers that import a module-level 'application'
application = create_app()

