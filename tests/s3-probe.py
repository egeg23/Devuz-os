# SPDX-License-Identifier: LGPL-2.1-or-later
# Только тест: проверить подставное облако S3 на раннере до загрузки коробки —
# создать корзину, записать и прочитать файл подписанными запросами (как restic).
import sys

import boto3

url, key_id, secret = sys.argv[1:4]
s3 = boto3.client("s3", endpoint_url=url, aws_access_key_id=key_id, aws_secret_access_key=secret, region_name="us-east-1")
s3.create_bucket(Bucket="devuz-probe")
s3.put_object(Bucket="devuz-probe", Key="probe.txt", Body=b"probe")
assert s3.get_object(Bucket="devuz-probe", Key="probe.txt")["Body"].read() == b"probe"
print("S3 ok")
