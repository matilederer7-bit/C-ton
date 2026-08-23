import Foundation
import Security
import Capacitor

@objc(SitonSecureStoragePlugin)
public class SitonSecureStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SitonSecureStoragePlugin"
    public let jsName = "SitonSecureStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]
    private let service = "il.co.siton.securestorage.v1"
    private let maxValueBytes = 65_536

    private func key(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key"), key.range(of: "^siton_[a-z0-9_]{1,80}$", options: .regularExpression) != nil else { call.reject("key is invalid"); return nil }
        return key
    }

    private func query(_ key: String) -> [String: Any] {
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = key(call), let value = call.getString("value"), !value.isEmpty, let data = value.data(using: .utf8), data.count <= maxValueBytes else { call.reject("value is invalid"); return }
        let base = query(key)
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        status == errSecSuccess ? call.resolve() : call.reject("secure_storage_set_failed", "keychain_\(status)")
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = key(call) else { return }
        var request = query(key)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound { call.resolve(["value": NSNull()]); return }
        guard status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) else { call.reject("secure_storage_get_failed", "keychain_\(status)"); return }
        call.resolve(["value": value])
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = key(call) else { return }
        let status = SecItemDelete(query(key) as CFDictionary)
        (status == errSecSuccess || status == errSecItemNotFound) ? call.resolve() : call.reject("secure_storage_remove_failed", "keychain_\(status)")
    }
}
