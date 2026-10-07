package store.adityastudio.deliverymanage;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4401;
    private static final String DELIVERY_CHANNEL_ID = "delivery_orders";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createDeliveryAlertChannel();
        requestNotificationPermissionOnLaunch();
    }

    private void createDeliveryAlertChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                DELIVERY_CHANNEL_ID,
                "Delivery alerts",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("New delivery orders and customer messages");
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 250, 120, 300});
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void requestNotificationPermissionOnLaunch() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        new Handler(Looper.getMainLooper()).postDelayed(() ->
                ActivityCompat.requestPermissions(
                        this,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        NOTIFICATION_PERMISSION_REQUEST
                ), 600);
    }
}