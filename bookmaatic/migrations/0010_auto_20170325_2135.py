# -*- coding: utf-8 -*-
# Generated by Django 1.10.6 on 2017-03-26 01:35
from __future__ import unicode_literals

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('bookmaatic', '0009_auto_20170325_2101'),
    ]

    operations = [
        migrations.RenameModel(
            old_name='MyUser',
            new_name='User',
        ),
    ]
