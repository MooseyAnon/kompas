import fs from 'node:fs';

const { productName, version } = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

console.log(
  JSON.stringify(
    {
      name: productName,
      version,
      tag: `v${version}`,
      bundleIdentifier: 'com.kompas.kompas',
      platform: 'darwin',
      arch: 'arm64',
      app: `out/${productName}-darwin-arm64/${productName}.app`,
      artifacts: [
        `${productName}-${version}-mac-arm64.dmg`,
        `${productName}-${version}-mac-arm64.zip`,
      ],
      signing:
        process.env.KOMPAS_RELEASE === '1'
          ? 'required'
          : 'unsigned development',
    },
    null,
    2,
  ),
);
