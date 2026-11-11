# 签名与发布说明

## 两种 APK 的区别

| 文件 | 签名 | 用途 | 能否覆盖安装 |
| --- | --- | --- | --- |
| `photo-triage-release.apk` | release keystore | 日常使用 / 分发 | ✅ 后续版本可直接覆盖升级 |
| `photo-triage-debug.apk` | Android debug | 开发调试 | ❌ 与 release 版本签名不同，不能互相覆盖 |

> 两个包名相同（`com.tiaopian.app`），但签名不同，**安装其中一个前需要先卸载另一个**。日常使用请装 release 版。

## release 签名信息

- keystore 文件：`android/app/tiaopian-release.jks`
- 别名：`tiaopian`
- 证书：`CN=TiaoPian, OU=Photo Sift, O=TiaoPian, L=Local, ST=Local, C=CN`
- 证书 SHA-256：`a956aa39122261786363fc3ad16ba76f88ca563035bdfe322dcf529b0143ab67`
- 有效期：10000 天
- 口令：见 `android/keystore.properties`（**已加入 .gitignore，不会进仓库**）

### ⚠️ 请立刻备份这两个文件

```
android/app/tiaopian-release.jks
android/keystore.properties
```

**keystore 丢了就无法再为已安装用户发布可覆盖升级的版本**，只能让所有用户卸载重装并丢失 App 内数据。建议复制到你自己的网盘或密码管理器。

## 构建命令

```bash
cd photo-triage-native
npx cap sync android

# release（正式分发）
cd android
./gradlew assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk

# debug（调试）
./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

如果 `keystore.properties` 缺失，release 构建会自动回退到 debug 签名并打印警告，避免 CI / 新机器上直接构建失败。

也可以用环境变量指定 keystore 路径：

```bash
TIAPOPIAN_STORE_FILE=/absolute/path/to/tiaopian-release.jks ./gradlew assembleRelease
```

## 版本号

在 `android/app/signing.gradle` 里维护：

```groovy
versionCode 2      // 每次发版 +1，Android 用它判断能否覆盖安装
versionName "1.1"  // 展示给用户的版本号
```

## 更换签名（如需）

如果要换成你自己的 keystore（例如公司签名或 Google Play 上架）：

1. 在 `android/app/` 放新的 `.jks`
2. 修改 `android/keystore.properties` 的 `storeFile` / `keyAlias` 与两个口令
3. 重新 `./gradlew assembleRelease`

注意：更换签名后，已安装旧签名的用户必须卸载重装。
