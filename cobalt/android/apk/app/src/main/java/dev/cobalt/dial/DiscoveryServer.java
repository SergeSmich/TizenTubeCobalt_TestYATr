// Copyright 2026 Reis Can (reisxd). All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package dev.cobalt.dial;

import android.content.Context;
import dev.cobalt.util.Log;
import java.io.IOException;
import java.net.DatagramPacket;
import java.net.InetAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;

/**
 * UDP/SSDP discovery server for DIAL protocol.
 * Responds to M-SEARCH requests with a dd.xml location.
 */
public class DiscoveryServer {
  private static final String TAG = "DiscoveryServer";
  private static final String SSDP_MULTICAST_ADDRESS = "239.255.255.250";
  private static final int SSDP_PORT = 1900;
  private static final int SOCKET_TIMEOUT_MS = 1000;
  private static final String DIAL_SERVICE_TYPE = "urn:dial-multiscreen-org:service:dial:1";

  private static DiscoveryServer sInstance;
  private MulticastSocket mSocket;
  private Thread mListenerThread;
  private volatile boolean mIsRunning = false;

  private DiscoveryServer() {}

  public static synchronized DiscoveryServer getInstance() {
    if (sInstance == null) {
      sInstance = new DiscoveryServer();
    }
    return sInstance;
  }

  public synchronized void start(Context context) throws IOException {
    if (mIsRunning) {
      Log.w(TAG, "Discovery server is already running");
      return;
    }

    try {
      mSocket = new MulticastSocket(SSDP_PORT);
      mSocket.setReuseAddress(true);
      mSocket.setSoTimeout(SOCKET_TIMEOUT_MS);
      mSocket.joinGroup(InetAddress.getByName(SSDP_MULTICAST_ADDRESS));

      mIsRunning = true;
      mListenerThread = new Thread(new DiscoveryListener(DIALServer.getDialUdn(context)));
      mListenerThread.setName("DiscoveryServerThread");
      mListenerThread.start();

      Log.i(TAG, "Discovery server started, listening on " + SSDP_MULTICAST_ADDRESS + ":" + SSDP_PORT);
    } catch (IOException e) {
      Log.e(TAG, "Failed to start discovery server: " + e.getMessage());
      if (mSocket != null) {
        mSocket.close();
      }
      throw e;
    }
  }

  public synchronized void stop() {
    mIsRunning = false;
    if (mSocket != null) {
      mSocket.close();
    }
    if (mListenerThread != null) {
      try {
        mListenerThread.join(2000);
      } catch (InterruptedException e) {
        Log.w(TAG, "Interrupted waiting for listener thread: " + e.getMessage());
      }
    }
    Log.i(TAG, "Discovery server stopped");
  }

  public synchronized boolean isRunning() {
    return mIsRunning;
  }

  private static String getLocalIpAddress() {
    try {
      Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
      while (interfaces.hasMoreElements()) {
        NetworkInterface iface = interfaces.nextElement();
        if (iface.isLoopback() || !iface.isUp()) {
          continue;
        }
        Enumeration<InetAddress> addresses = iface.getInetAddresses();
        while (addresses.hasMoreElements()) {
          InetAddress addr = addresses.nextElement();
          String hostAddress = addr.getHostAddress();
          if (hostAddress.contains(".") && !hostAddress.contains(":")) {
            return hostAddress;
          }
        }
      }
    } catch (Exception e) {
      Log.w(TAG, "Failed to get local IP address: " + e.getMessage());
    }
    return "127.0.0.1";
  }

  private static String generateMSearchResponse(String localIp, String udn, String st) {
    String responseSt = (st == null || st.isEmpty()) ? DIAL_SERVICE_TYPE : st;
    StringBuilder response = new StringBuilder();
    response.append("HTTP/1.1 200 OK\r\n");
    response.append("LOCATION: http://").append(localIp).append(":8012/dd.xml\r\n");
    response.append("CACHE-CONTROL: max-age=1800\r\n");
    response.append("EXT:\r\n");
    response.append("BOOTID.UPNP.ORG: 1\r\n");
    response.append("CONFIGID.UPNP.ORG: 14650996\r\n");
    response.append("SERVER: Cobalt/2.0 UPnP/1.1\r\n");
    response.append("ST: ").append(responseSt).append("\r\n");
    response.append("USN: uuid:").append(udn).append("::").append(responseSt).append("\r\n");
    response.append("\r\n");
    return response.toString();
  }

  private static String extractStHeader(String request) {
    String[] lines = request.split("\\r?\\n");
    for (String line : lines) {
      String lower = line.toLowerCase();
      if (lower.startsWith("st:")) {
        return line.substring(3).trim();
      }
    }
    return "";
  }

  private class DiscoveryListener implements Runnable {
    private final String mLocalIp = getLocalIpAddress();
    private final String mUdn;

    DiscoveryListener(String udn) {
      mUdn = udn;
    }

    @Override
    public void run() {
      byte[] buffer = new byte[2048];

      while (mIsRunning) {
        try {
          DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
          try {
            mSocket.receive(packet);
          } catch (java.net.SocketTimeoutException e) {
            continue;
          }

          String request = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
          Log.d(TAG, "Received discovery request:\n" + request);

          if (request.startsWith("M-SEARCH")) {
            String requestLower = request.toLowerCase();
            if (requestLower.contains(DIAL_SERVICE_TYPE.toLowerCase())
                || requestLower.contains("ssdp:all")
                || requestLower.contains("upnp:rootdevice")) {
              String requestedSt = extractStHeader(request);
              String response = generateMSearchResponse(mLocalIp, mUdn, requestedSt);
              byte[] responseBytes = response.getBytes(StandardCharsets.UTF_8);
              DatagramPacket responsePacket = new DatagramPacket(
                  responseBytes,
                  responseBytes.length,
                  packet.getAddress(),
                  packet.getPort());
              mSocket.send(responsePacket);
              Log.i(TAG, "Sent M-SEARCH response to " + packet.getAddress() + ":" + packet.getPort());
            }
          }
        } catch (IOException e) {
          if (mIsRunning) {
            Log.e(TAG, "Error in discovery listener: " + e.getMessage());
          }
        }
      }

      Log.d(TAG, "Discovery listener thread exiting");
    }
  }
}
