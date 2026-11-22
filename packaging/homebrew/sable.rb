cask 'sable' do
  arch arm: 'arm64', intel: 'x64'

  version '2.0.0'
  sha256 arm:   '0000000000000000000000000000000000000000000000000000000000000000',
         intel: '0000000000000000000000000000000000000000000000000000000000000000'

  url "https://git.sable.moe/SableClient/sable-next/releases/download/v#{version}/sable-#{version}-#{arch}.dmg"
  name 'Sable'
  desc 'Client for the Matrix chat network'
  homepage 'https://sable.moe/'

  livecheck do
    url 'https://git.sable.moe/SableClient/sable-next/releases'
    regex(%r{/releases/tag/v?(\d+(?:\.\d+)+)}i)
  end

  auto_updates true
  depends_on :macos

  app 'Sable.app'

  uninstall quit: 'moe.sable.client'

  zap trash: [
    '~/Library/Application Support/moe.sable.client',
    '~/Library/Application Support/moe.sable.client.electron',
    '~/Library/Caches/moe.sable.client',
    '~/Library/HTTPStorages/moe.sable.client',
    '~/Library/Preferences/moe.sable.client.plist',
    '~/Library/Saved Application State/moe.sable.client.savedState',
    '~/Library/WebKit/moe.sable.client'
  ]
end
