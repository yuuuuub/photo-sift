package com.tiaopian.app;

import android.app.Activity;
import android.content.ContentUris;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.Settings;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;

/**
 * Delete MediaStore assets using Android's system confirmation flow.
 *
 * Android 11+ requires MediaStore.createDeleteRequest for media owned by other
 * apps. The user always sees a system confirmation dialog; this plugin never
 * deletes silently.
 */
@CapacitorPlugin(name = "PhotoDeleter")
public class PhotoDeleterPlugin extends Plugin {

    private static final int DELETE_CHUNK_SIZE = 2000;

    private ActivityResultLauncher<IntentSenderRequest> deleteLauncher;
    private PluginCall pendingDeleteCall;
    private ArrayList<String> pendingDeleteIds;

    @Override
    public void load() {
        super.load();
        deleteLauncher = bridge.registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            result -> {
                PluginCall call = pendingDeleteCall;
                ArrayList<String> ids = pendingDeleteIds;
                pendingDeleteCall = null;
                pendingDeleteIds = null;

                if (call == null) {
                    return;
                }

                boolean confirmed = result.getResultCode() == Activity.RESULT_OK;
                JSObject response = new JSObject();
                response.put("deleted", confirmed);
                response.put("canceled", !confirmed);
                response.put("ids", confirmed && ids != null ? new JSArray(ids) : new JSArray());
                call.resolve(response);
            }
        );
    }

    @PluginMethod
    public void deleteAssets(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            call.reject("需要 Android 11 或更高版本才能从系统相册删除照片。");
            return;
        }
        if (pendingDeleteCall != null) {
            call.reject("另一个系统删除请求正在进行中。");
            return;
        }

        JSArray idsArray = call.getArray("ids");
        if (idsArray == null || idsArray.length() == 0) {
            call.reject("没有提供要删除的照片。");
            return;
        }
        if (idsArray.length() > DELETE_CHUNK_SIZE) {
            call.reject("一次最多删除 " + DELETE_CHUNK_SIZE + " 张照片。");
            return;
        }

        List<Uri> uris = new ArrayList<>();
        ArrayList<String> ids = new ArrayList<>();
        for (int i = 0; i < idsArray.length(); i++) {
            String id = idsArray.optString(i, null);
            Uri uri = mediaUriForId(id);
            if (uri != null) {
                uris.add(uri);
                ids.add(id);
            }
        }

        if (uris.isEmpty()) {
            call.reject("没有找到可删除的相册照片。");
            return;
        }

        try {
            android.app.PendingIntent request = MediaStore.createDeleteRequest(
                getContext().getContentResolver(),
                uris
            );
            pendingDeleteCall = call;
            pendingDeleteIds = ids;
            call.setKeepAlive(true);
            deleteLauncher.launch(
                new IntentSenderRequest.Builder(request.getIntentSender()).build()
            );
        } catch (Exception error) {
            pendingDeleteCall = null;
            pendingDeleteIds = null;
            call.reject("无法打开系统删除确认：" + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent intent = new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getContext().getPackageName())
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("无法打开系统设置：" + error.getMessage(), error);
        }
    }

    private Uri mediaUriForId(String id) {
        if (id == null || id.isEmpty()) {
            return null;
        }
        String[] parts = id.split(":", 2);
        String type = parts.length == 2 ? parts[0] : "image";
        String rawId = parts.length == 2 ? parts[1] : parts[0];
        if (!"image".equals(type)) {
            return null;
        }
        try {
            long mediaId = Long.parseLong(rawId);
            Uri collection = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
                : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
            return ContentUris.withAppendedId(collection, mediaId);
        } catch (NumberFormatException error) {
            return null;
        }
    }
}
