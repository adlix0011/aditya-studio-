package store.adityastudio.deliverymanage;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "DeliveryPermissions",
    permissions = {
        @Permission(alias = "notifications", strings = {"android.permission.POST_NOTIFICATIONS"}),
        @Permission(alias = "location", strings = {
            "android.permission.ACCESS_FINE_LOCATION",
            "android.permission.ACCESS_COARSE_LOCATION"
        }),
        @Permission(alias = "backgroundLocation", strings = {"android.permission.ACCESS_BACKGROUND_LOCATION"})
    }
)
public class DeliveryPermissionsPlugin extends Plugin {
    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            call.resolve(status());
            return;
        }
        requestPermissionForAlias("notifications", call, "permissionResult");
    }

    @PluginMethod
    public void requestLocation(PluginCall call) {
        requestPermissionForAlias("location", call, "permissionResult");
    }

    @PluginMethod
    public void requestBackgroundLocation(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.resolve(status());
            return;
        }
        requestPermissionForAlias("backgroundLocation", call, "permissionResult");
    }

    @PluginMethod
    public void requestBatteryUnrestricted(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
            call.resolve(status());
        } catch (Exception error) {
            Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            getActivity().startActivity(intent);
            call.resolve(status());
        }
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        call.resolve(status());
    }

    private JSObject status() {
        JSObject value = new JSObject();
        value.put("notifications", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED);
        value.put("location", getPermissionState("location") == PermissionState.GRANTED);
        value.put("backgroundLocation", Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || getPermissionState("backgroundLocation") == PermissionState.GRANTED);
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        value.put("batteryUnrestricted", power != null && power.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        return value;
    }
}
