# -*- coding: utf-8 -*-
# Generated by Django 1.10.6 on 2017-03-24 21:16
from __future__ import unicode_literals

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('bookmaatic', '0005_administrator'),
    ]

    operations = [
        migrations.AlterField(
            model_name='administrator',
            name='email',
            field=models.EmailField(blank=True, max_length=254, verbose_name='e-mail'),
        ),
        migrations.AlterField(
            model_name='administrator',
            name='name',
            field=models.ForeignKey(default='auth.User', on_delete=django.db.models.deletion.CASCADE, to=settings.AUTH_USER_MODEL),
        ),
        migrations.AlterField(
            model_name='book',
            name='comment_feature',
            field=models.IntegerField(blank=True, null=True),
        ),
    ]
