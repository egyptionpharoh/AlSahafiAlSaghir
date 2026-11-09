# حاوية تشغيل «الصحفي الصغير» — لا تحتاج npm install (لا توجد اعتماديات)
FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    BACKUPS_DIR=/data/backups \
    TRUST_PROXY=1
# اربط /data بقرص دائم (Volume / Persistent Disk) في منصة الاستضافة
VOLUME ["/data"]
EXPOSE 3000
# ملاحظة: يعمل بالمستخدم الافتراضي لأن أقراص بعض المنصات تُربط بصلاحيات root.
# إن كانت منصتك تسمح، أضف:  RUN mkdir -p /data && chown node:node /data  ثم  USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
