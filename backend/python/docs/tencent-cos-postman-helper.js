/**
 * Tencent COS Postman helper.
 *
 * 用途：
 * 1. 在浏览器控制台生成 COS PUT 上传所需的 URL 和 Authorization。
 * 2. 在 Postman 中用 PUT + binary 文件上传图片到腾讯 COS。
 * 3. 上传成功后，再生成 COS GET 签名 URL，用于验证图片是否可访问，
 *    也可作为后续图片模型接口里的 image URL。
 *
 * 注意：
 * - 当前 Python 服务使用的是 Tencent COS，不是 TOS。
 * - 不要把真实 SecretId / SecretKey 提交到 GitHub。
 * - COS_PUT_AUTH 和 COS_GET_URL 都有时效性，过期后需要重新生成。
 * - PUT 上传成功一般返回空 body 或很短的响应，不会返回图片 URL。
 *   真正的图片访问地址是 GET 签名 URL。
 *
 * 总心智模型：
 * Step 1 生成 PUT 上传参数：得到 COS_OBJECT_KEY / COS_UPLOAD_URL / COS_PUT_AUTH。
 * Step 2 调用 PUT 上传：把本地图片二进制真正写入 COS，返回 200 才代表对象存在。
 * Step 3 生成 GET 访问 URL：基于已存在的 COS_OBJECT_KEY 生成可访问的签名 URL。
 * Step 4 调用 GET 访问图片：拿到图片二进制内容，用于验证图片真的可访问。
 * Step 5 一键串起来：选择文件、上传、生成 GET URL、访问验证，最后返回模型可用图片 URL。
 */

async function generateCosPutForPostman({
  secretId,
  secretKey,
  bucket,
  region,
  prefix = "seedance-face-review/",
  fileStem = "postman-test",
  ext = ".png",
  expires = 600,
}) {
  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function utcDate() {
    const d = new Date();
    return (
      d.getUTCFullYear() +
      pad2(d.getUTCMonth() + 1) +
      pad2(d.getUTCDate())
    );
  }

  function randomHex(length = 12) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    return [...bytes]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, length);
  }

  // Match Python urllib.parse.quote:
  // letters / digits / - . _ ~ are always safe; extra safe chars are added by caller.
  function quoteLikePython(value, extraSafe = "") {
    const safe = new Set(("-._~" + extraSafe).split(""));
    const bytes = new TextEncoder().encode(value);
    let out = "";

    for (const b of bytes) {
      const ch = String.fromCharCode(b);
      const isAlphaNum =
        (b >= 48 && b <= 57) ||
        (b >= 65 && b <= 90) ||
        (b >= 97 && b <= 122);

      if (isAlphaNum || safe.has(ch)) {
        out += ch;
      } else {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }

    return out;
  }

  async function sha1Hex(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-1", data);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function hmacSha1Hex(keyText, messageText) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(keyText),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );

    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(messageText)
    );

    return [...new Uint8Array(sig)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  prefix = String(prefix || "seedance-face-review/").replace(/^\/+/, "");
  if (prefix && !prefix.endsWith("/")) prefix += "/";

  const safeStem =
    String(fileStem || "postman-test")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "") || "postman-test";

  const objectKey = `${prefix}${utcDate()}/${safeStem}-${randomHex(12)}${ext}`;
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const objectUri = "/" + quoteLikePython(objectKey.replace(/^\/+/, ""), "/");

  const now = Math.floor(Date.now() / 1000);
  const signTime = `${now};${now + expires}`;
  const keyTime = signTime;

  const method = "put";
  const signedHeaders = "host=" + quoteLikePython(host.toLowerCase(), "");

  const httpString =
    `${method}\n` +
    `${objectUri}\n` +
    `\n` +
    `${signedHeaders}\n`;

  const stringToSign =
    `sha1\n` +
    `${signTime}\n` +
    `${await sha1Hex(httpString)}\n`;

  const signKey = await hmacSha1Hex(secretKey, keyTime);
  const signature = await hmacSha1Hex(signKey, stringToSign);

  const authorization =
    `q-sign-algorithm=sha1` +
    `&q-ak=${quoteLikePython(secretId, "")}` +
    `&q-sign-time=${signTime}` +
    `&q-key-time=${keyTime}` +
    `&q-header-list=host` +
    `&q-url-param-list=` +
    `&q-signature=${signature}`;

  const uploadUrl = `https://${host}${objectUri}`;

  return {
    COS_OBJECT_KEY: objectKey,
    COS_UPLOAD_URL: uploadUrl,
    COS_PUT_AUTH: authorization,
    expiresAt: new Date((now + expires) * 1000).toISOString(),
    debug: {
      host,
      objectUri,
      httpString,
      stringToSign,
      signature,
    },
  };
}

async function generateCosGetUrlForPostman({
  secretId,
  secretKey,
  bucket,
  region,
  objectKey,
  expires = 3600,
}) {
  const enc = new TextEncoder();

  function quoteLikePython(value, safeExtra = "") {
    const alwaysSafe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const safe = alwaysSafe + safeExtra;
    return Array.from(enc.encode(String(value)))
      .map((byte) => {
        const ch = String.fromCharCode(byte);
        return safe.includes(ch)
          ? ch
          : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
      })
      .join("");
  }

  async function sha1Hex(text) {
    const buf = await crypto.subtle.digest("SHA-1", enc.encode(text));
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function hmacSha1Hex(keyText, msgText) {
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(keyText),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msgText));
    return [...new Uint8Array(sig)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  const now = Math.floor(Date.now() / 1000);
  const signTime = `${now};${now + expires}`;
  const keyTime = signTime;
  const method = "get";
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const uri = "/" + quoteLikePython(objectKey.replace(/^\/+/, ""), "/-_.~");

  const httpString = `${method}\n${uri}\n\nhost=${quoteLikePython(host.toLowerCase(), "")}\n`;
  const stringToSign = `sha1\n${signTime}\n${await sha1Hex(httpString)}\n`;

  const signKey = await hmacSha1Hex(secretKey, keyTime);
  const signature = await hmacSha1Hex(signKey, stringToSign);

  const auth =
    `q-sign-algorithm=sha1` +
    `&q-ak=${encodeURIComponent(secretId)}` +
    `&q-sign-time=${signTime}` +
    `&q-key-time=${keyTime}` +
    `&q-header-list=host` +
    `&q-url-param-list=` +
    `&q-signature=${signature}`;

  const url = `https://${host}${uri}?${auth}`;

  console.log("COS_GET_URL =", url);
  return url;
}

/**
 * 调用函数 1：直接在浏览器控制台上传文件到 COS。
 *
 * 适合场景：
 * - 你不想打开 Postman，只想在浏览器里快速验证 PUT 上传是否可用。
 * - 你已经通过 generateCosPutForPostman 生成了 COS_UPLOAD_URL 和 COS_PUT_AUTH。
 *
 * 使用方式：
 * 1. 先执行 generateCosPutForPostman，拿到 cos。
 * 2. 再执行：
 *
 *    await putFileToCosFromBrowser({
 *      uploadUrl: cos.COS_UPLOAD_URL,
 *      authorization: cos.COS_PUT_AUTH,
 *      contentType: "image/png"
 *    });
 *
 * 3. 浏览器会弹出文件选择框。
 * 4. 上传成功一般返回 200 OK，响应 body 通常为空或很短。
 */
async function putFileToCosFromBrowser({
  uploadUrl,
  authorization,
  contentType = "image/png",
}) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";

  const file = await new Promise((resolve, reject) => {
    input.onchange = () => {
      const selected = input.files && input.files[0];
      selected ? resolve(selected) : reject(new Error("No file selected."));
    };
    input.click();
  });

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": file.type || contentType,
    },
    body: file,
    redirect: "follow",
  });

  const result = await response.text();

  console.log("COS_PUT_STATUS =", response.status, response.statusText);
  console.log("COS_PUT_RESPONSE =", result);

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    responseText: result,
  };
}

/**
 * 调用函数 2：直接在浏览器控制台访问 COS 图片。
 *
 * 适合场景：
 * - 你已经生成了 COS_GET_URL。
 * - 想验证这个签名 URL 是否真的能访问图片。
 * - 想把返回的二进制图片内容临时转成 blob URL，在浏览器里打开预览。
 *
 * 使用方式：
 *
 *    await getCosImageFromBrowser(getUrl);
 *
 * 返回说明：
 * - GET 请求返回的是图片二进制内容，不是 JSON，也不是另一个 URL。
 * - imageUrl 是浏览器本地临时 blob URL，只用于当前浏览器预览。
 * - 真正给模型接口使用的图片 URL 仍然是传入的 signedUrl。
 */
async function getCosImageFromBrowser(signedUrl) {
  const response = await fetch(signedUrl, {
    method: "GET",
    redirect: "follow",
  });

  const blob = await response.blob();
  const imageUrl = URL.createObjectURL(blob);

  console.log("COS_GET_STATUS =", response.status, response.statusText);
  console.log("COS_GET_CONTENT_TYPE =", response.headers.get("content-type"));
  console.log("COS_GET_BYTES =", blob.size);
  console.log("COS_GET_PREVIEW_BLOB_URL =", imageUrl);
  console.log("MODEL_IMAGE_URL =", signedUrl);

  window.open(imageUrl, "_blank");

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type"),
    bytes: blob.size,
    previewBlobUrl: imageUrl,
    modelImageUrl: signedUrl,
  };
}

/**
 * 依赖常量说明：
 *
 * secretId:
 * - 对应 Python .env.local 里的 TENCENT_SECRET_ID。
 * - 用于参与签名，告诉 COS 这次请求属于哪个腾讯云密钥。
 *
 * secretKey:
 * - 对应 Python .env.local 里的 TENCENT_SECRET_KEY。
 * - 用于计算签名，绝对不要提交到 GitHub。
 *
 * bucket:
 * - 对应 Python .env.local 里的 TENCENT_COS_BUCKET。
 * - 例如 ldm-1409537125。
 *
 * region:
 * - 对应 Python .env.local 里的 TENCENT_COS_REGION。
 * - 例如 ap-beijing。
 *
 * prefix:
 * - 对应 Python .env.local 里的 TENCENT_COS_PREFIX。
 * - 表示上传到 COS 后对象路径的前缀目录，不是本地目录。
 *
 * fileStem / ext:
 * - fileStem 是生成对象名时的人类可读前缀。
 * - ext 是对象后缀，最好和真实文件格式一致，比如 .png / .jpg / .webp。
 *
 * putExpiresSeconds:
 * - PUT 上传签名有效期。
 * - 过期后上传会失败，需要重新生成 COS_PUT_AUTH。
 *
 * getExpiresSeconds:
 * - GET 访问签名有效期。
 * - 过期后图片 URL 无法继续访问，需要重新生成 COS_GET_URL。
 */
const COS_CONFIG = {
  secretId: "替换成你的 TENCENT_SECRET_ID",
  secretKey: "替换成你的 TENCENT_SECRET_KEY",
  bucket: "ldm-1409537125",
  region: "ap-beijing",
  prefix: "seedance-face-review/",
  fileStem: "postman-test",
  ext: ".png",
  putExpiresSeconds: 600,
  getExpiresSeconds: 3600,
};

/**
 * 第一步：生成 PUT 上传参数。
 *
 * 这一步只是“生成上传凭证和上传地址”，还没有真正上传图片。
 *
 * 产出：
 * - COS_OBJECT_KEY: 图片未来在 COS 里的对象路径，例如 seedance-face-review/20260522/postman-test-xxxx.png。
 * - COS_UPLOAD_URL: PUT 上传地址，只用于上传。
 * - COS_PUT_AUTH: PUT 请求需要放到 Authorization header 的签名。
 *
 * 下一步为什么需要它：
 * - 第二步真正上传图片时，必须使用 COS_UPLOAD_URL + COS_PUT_AUTH。
 */
async function step1GeneratePutParams(config = COS_CONFIG) {
  const cos = await generateCosPutForPostman({
    secretId: config.secretId,
    secretKey: config.secretKey,
    bucket: config.bucket,
    region: config.region,
    prefix: config.prefix,
    fileStem: config.fileStem,
    ext: config.ext,
    expires: config.putExpiresSeconds,
  });

  console.log("STEP_1_COS_OBJECT_KEY =", cos.COS_OBJECT_KEY);
  console.log("STEP_1_COS_UPLOAD_URL =", cos.COS_UPLOAD_URL);
  console.log("STEP_1_COS_PUT_AUTH =", cos.COS_PUT_AUTH);
  console.log("STEP_1_PUT_EXPIRES_AT =", cos.expiresAt);

  return cos;
}

/**
 * 第二步：调用 PUT 上传到 COS。
 *
 * 这一步才是真正把“本地图片文件的二进制内容”上传到 COS。
 *
 * 入参：
 * - 第一步生成的 cos。
 *
 * 浏览器会弹出文件选择框，你选择要上传的图片。
 *
 * 返回：
 * - ok / status / responseText。
 * - COS 的 PUT 成功响应通常不是图片 URL，而是空内容或很短的文本。
 *
 * 为什么需要第二步：
 * - 第一步只是拿到上传地址和签名。
 * - 只有第二步返回 200 OK 后，COS_OBJECT_KEY 对应的图片对象才真实存在。
 */
async function step2UploadFileToCos(cos, contentType = "image/png") {
  return await putFileToCosFromBrowser({
    uploadUrl: cos.COS_UPLOAD_URL,
    authorization: cos.COS_PUT_AUTH,
    contentType,
  });
}

/**
 * 第三步：生成 GET 图片访问 URL。
 *
 * 这一步基于第一步产出的 COS_OBJECT_KEY 生成“可访问图片的签名 URL”。
 *
 * 入参：
 * - cos.COS_OBJECT_KEY。
 *
 * 产出：
 * - COS_GET_URL: 可以给浏览器、Postman、图片模型接口使用的图片 URL。
 *
 * 注意：
 * - COS_GET_URL 有有效期。
 * - 如果桶是私有的，不能只用 COS_UPLOAD_URL 去访问图片，必须用 GET 签名 URL。
 */
async function step3GenerateGetUrl(cos, config = COS_CONFIG) {
  const getUrl = await generateCosGetUrlForPostman({
    secretId: config.secretId,
    secretKey: config.secretKey,
    bucket: config.bucket,
    region: config.region,
    objectKey: cos.COS_OBJECT_KEY,
    expires: config.getExpiresSeconds,
  });

  console.log("STEP_3_COS_GET_URL =", getUrl);
  console.log("STEP_3_MODEL_IMAGE_URL =", getUrl);

  return getUrl;
}

/**
 * 第四步：GET 访问图片。
 *
 * 这一步用于验证第三步生成的 COS_GET_URL 是否真的能访问图片。
 *
 * 返回：
 * - 图片二进制内容会被浏览器转成 blob。
 * - previewBlobUrl 只是当前浏览器临时预览地址。
 * - modelImageUrl 才是后续给模型接口使用的 COS 签名图片 URL。
 */
async function step4GetImage(getUrl) {
  return await getCosImageFromBrowser(getUrl);
}

/**
 * 第五步：一键串起完整流程。
 *
 * 这个函数包含前四步：
 * 1. 生成 PUT 上传参数。
 * 2. 选择本地图片并上传到 COS。
 * 3. 基于 COS_OBJECT_KEY 生成 GET 签名图片 URL。
 * 4. GET 访问图片，确认图片真的可用。
 *
 * 最终返回：
 * - cos: 第一步生成的上传信息。
 * - uploadResult: 第二步 PUT 上传结果。
 * - getUrl: 第三步生成的模型可用图片 URL。
 * - getResult: 第四步 GET 验证结果。
 *
 * 使用方式：
 *
 * const result = await runCosUploadAndGetDemo();
 * console.log(result.getUrl);
 */
async function runCosUploadAndGetDemo(config = COS_CONFIG) {
  const cos = await step1GeneratePutParams(config);
  const uploadResult = await step2UploadFileToCos(cos, "image/png");

  if (!uploadResult.ok) {
    throw new Error(`COS upload failed: ${uploadResult.status} ${uploadResult.statusText}`);
  }

  const getUrl = await step3GenerateGetUrl(cos, config);
  const getResult = await step4GetImage(getUrl);

  if (!getResult.ok) {
    throw new Error(`COS get failed: ${getResult.status} ${getResult.statusText}`);
  }

  console.log("FINAL_MODEL_IMAGE_URL =", getUrl);

  return {
    cos,
    uploadResult,
    getUrl,
    getResult,
  };
}

/**
 * 手动分步执行示例：
 *
 * const cos = await step1GeneratePutParams();
 * await step2UploadFileToCos(cos, "image/png");
 * const getUrl = await step3GenerateGetUrl(cos);
 * await step4GetImage(getUrl);
 *
 * 一键执行示例：
 *
 * const result = await runCosUploadAndGetDemo();
 * console.log("给模型用的图片 URL =", result.getUrl);
 */
