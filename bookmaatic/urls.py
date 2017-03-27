from django.conf.urls import url
from . import views

urlpatterns = [
    url(r'^$', views.book_list, name='list'),
    url(r'^book/(?P<pk>\d+)/$', views.book_detail, name='detail'),    
    url(r'^book/new/$', views.book_new, name='new'),
    url(r'^book/(?P<pk>\d+)/edit/$', views.book_edit, name='edit'),    
]