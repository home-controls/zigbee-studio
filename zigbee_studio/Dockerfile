ARG BUILD_FROM
FROM ${BUILD_FROM}

COPY requirements.lock /tmp/requirements.lock
RUN pip3 install --no-cache-dir --only-binary=:all: --require-hashes -r /tmp/requirements.lock

# app/static is the built web page (npm run build in web/), committed so the add-on builds
# without Node on the Home Assistant machine
COPY app /app
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
