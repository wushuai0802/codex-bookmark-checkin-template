# Generated from shared/checkin-contract.json. Run npm run contracts; do not edit.
$CheckinFeatureDisabledEvidence = @{
    'new_api_status' = @('budele_enabled_false')
    'bmapi_checkin_status' = @('enabled_false')
    'new_api_checkin_status' = @('message_not_enabled')
    'new_api_checkin_action' = @('message_not_enabled')
}
$CheckinExternalRetryCauses = @('upstream_unavailable', 'rate_limit', 'harvest_waiting')
$CheckinSiteFaultCodes = @('tls_certificate_invalid', 'tls_handshake_failed', 'site_server_error', 'dns_validation_failed')
$CheckinNativePtHeaderOrigins = @('https://audiences.me', 'https://ourbits.club', 'https://piggo.me', 'https://www.hdkyl.in', 'https://ptsbao.club')
$CheckinNativePtUnsignedLabels = @{
    'https://audiences.me' = @('签到', '每日签到')
    'https://ourbits.club' = @('签到', '签到得魔力')
    'https://piggo.me' = @('签到', '签到得魔力')
    'https://www.hdkyl.in' = @('签到', '签到得魔力')
    'https://ptsbao.club' = @('签到', '签到得魔力')
}
