# 隐私说明 / PRIVACY

挑片（Photo Sift）是一个**照片只在本地处理**的整理工具。这份文档说明数据流向，方便你自行核对。

## 一句话总结

- 照片、缩略图、文件名、EXIF、相册信息**从不上传**
- 没有账号、没有统计、没有崩溃上报
- 只有「检查更新」会访问一个公开的 GitHub 接口，且不携带任何照片数据

## 各版本的数据流向

### 网页版（`photo-triage/`）

| 行为 | 数据流向 |
| --- | --- |
| 选择照片 | 图片通过 `URL.createObjectURL()` 在内存中读取，不发起网络请求 |
| 整理 / 相似分组 / 放大 | 全部在浏览器内存和 canvas 中完成 |
| 导出清单 | 用 `Blob` 在本地生成 `.txt` 下载，不上传 |
| 保存的结果 | 无。刷新页面后状态清空（引导提示记在 `localStorage`） |

代码中没有任何 `fetch` / `XMLHttpRequest` 调用（可用仓库内全文搜索核对）。

### Android 原生版（`photo-triage-native/`）

| 行为 | 数据流向 |
| --- | --- |
| 读取相册 | 通过 Android `MediaStore` / PhotoLibrary 插件在本机读取 |
| 生成缩略图 | 由系统在本机生成，写入应用缓存 |
| 相似照片分析 | 缩放后的灰度矩阵在 WebView 内计算，不上传 |
| 删除照片 | 通过 `MediaStore.createDeleteRequest` 交给 Android 系统确认，App 不直接删文件 |
| 检查更新 | 访问 `https://api.github.com/repos/yuuuuub/photo-sift/releases/latest`，只读取公开版本号，**不发送任何本地数据** |

### 网络权限

App 声明 `android.permission.INTERNET`，唯一用途是「检查更新」拉取公开的版本信息。

## 应用内数据

- 引导是否看过：`localStorage` 中的一个标记
- 上次选择的相似照片扫描范围：`localStorage` 中的一个数字
- 整理过程中的状态：只在内存里，关闭 App 即清空

卸载 App 会清除以上全部数据。

## 相册访问权限

- Android 13+：`READ_MEDIA_IMAGES` / `READ_MEDIA_VISUAL_USER_SELECTED`
- Android 11–12：`READ_EXTERNAL_STORAGE`（`maxSdkVersion=32`）

权限被拒绝时 App 仍可打开，只会提示去系统设置授权。

## 照片删除说明

- 网页版**不能**真正删除系统相册中的照片，左滑只是标记
- 原生版会先弹出 App 内确认（列出缩略图），再交给 Android 系统弹窗确认，两次确认后才会永久删除
- 删除后照片进入系统回收站（如果系统支持），与普通相册删除行为一致

## 自行核对

所有源码都在仓库里，可重点查看：

- `photo-triage-native/www/version.js`：唯一的网络请求
- `photo-triage-native/www/similar.js`：相似照片的本地计算
- `photo-triage-native/www/app.js`：删除流程与状态管理
- `photo-triage-native/android/app/src/main/java/com/tiaopian/app/PhotoDeleterPlugin.java`：原生删除实现
