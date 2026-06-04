import mimetypes
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('text/css', '.css')

from web import app


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
